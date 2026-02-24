#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <PubSubClient.h>
#include <LiquidCrystal_I2C.h>
#include <WiFiManager.h>   // tzapu/WiFiManager

// ================= PINS =================
#define PIR_PIN   13
#define LDR_PIN   34

// ✅ แนะนำ: GPIO12 เป็น strap pin เสี่ยงบูต/รีเลย์เพี้ยน
// ถ้าคุณยังต่อที่ 12 อยู่ "ใช้ได้" แต่แนะนำย้ายเป็น 25/26/27/32/33
#define RELAY_PIN 26   // <<< เปลี่ยนจาก 12 เป็น 26 ให้เสถียรกว่า

#define LED_WIFI  2
#define LED_DATA  4   // ✅ ใช้เป็น LED สถานะ MQTT (ภายนอก)

// ✅ ปุ่มล้าง WiFi (ปุ่มต่อกับ GND)
#define WIFI_RESET_PIN  16

// ================= LED POLARITY =================
// 0 = Active-HIGH (GPIO->R->LED->GND)
// 1 = Active-LOW  (3.3V->R->LED->GPIO)
#define LED_ACTIVE_LOW  0

// ================= RELAY POLARITY =================
// ✅ รีเลย์โมดูลส่วนใหญ่เป็น Active-LOW (IN=LOW แล้วดูด)
// ถ้าสั่งแล้วกลับด้าน ให้สลับค่านี้
#define RELAY_ACTIVE_LOW  1

// ================= LCD =================
LiquidCrystal_I2C lcd(0x27, 20, 4);

// ================= MQTT =================
const char* mqtt_server = "broker.hivemq.com";
String clientId;

String topic_pub = "smartdesk/ESP32-SDA-REAL/telemetry";
String topic_cmd = "smartdesk/ESP32-SDA-REAL/cmd";
String topic_lcd_standby = "smartdesk/ESP32-SDA-REAL/lcd/standby"; // retained state

// ================= TELEGRAM =================
String TG_BOT_TOKEN = "8403689774:AAHBKumZ1HiGNdgElbKsZ58yT9Brh0bM99k";
String TG_CHAT_ID   = "7944670448";

// ================= STATE =================
WiFiClient espClient;
PubSubClient mqtt(espClient);

// ================= WIFI MANAGER RUNTIME =================
WiFiManager wm;

// ✅ Offline flag: true when no WiFi connection at boot
bool offlineMode = false;
unsigned long lastWifiReconnectAttempt = 0;
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 10000; // 10s


bool pirDetected = false;
bool relayOn = false;
bool autoMode = true;
bool forcedAutoOffline = false; // ✅ force AUTO when offline
int  ldrValue = 0;

// timers / rate limit
unsigned long lastMqtt = 0;
unsigned long pirLowStart = 0;
unsigned long brightStart = 0;

// thresholds
const int LDR_ON_TH  = 1500;
const int LDR_OFF_TH = 1800;

const unsigned long NO_MOTION_OFF    = 30000; // 30s
const unsigned long BRIGHT_OFF_DELAY = 5000;  // 5s

// ===== Telegram anti-spam =====
bool prevRelayNotify = false;
bool prevWifiNotify  = false;
bool prevMqttNotify  = false;
unsigned long lastTgSentMs = 0;
const unsigned long TG_COOLDOWN_MS = 1200;

// ===== LCD Views =====
enum LcdView { LCD_STANDBY, LCD_LIVE };
LcdView lcdView = LCD_STANDBY;

// Standby text
String standbyLine2 = "My Smart Desktop";
String standbyLine3 = "Waiting for change";

// ===== Mode C =====
unsigned long lastMeaningfulChangeMs = 0;
unsigned long stableRequiredMs = 10000; // default 10s

// change detection memory
int lastPir   = -1;
int lastRelay = -1;
int lastAuto  = -1;
int lastLdr   = -9999;
const int LDR_DEADBAND = 40;
// ================= SITTING TRACKER (60min alert / 10min leave confirm) =================
const unsigned long LEAVE_CONFIRM_MS  = 30000; // หาย motion เกิน 30 วินาที = ลุกจริง
const unsigned long SIT_ALERT_MS      = 60000; // นั่งเกิน 60 วินาที = เตือน
const unsigned long ALERT_REPEAT_MS   = 5000; // เตือนซ้ำทุก 1 นาที

bool seated = false;
uint32_t seatSessionId = 0;
unsigned long seatSessionStartMs = 0;
unsigned long seatLastMotionMs   = 0;
unsigned long seatLastAlertMs    = 0;
bool seatStartSent = false;

// publish event ไปฝั่ง server (เก็บ DB) ผ่าน topic telemetry เดิม
void publishEvent(const String& type, const String& extraJson = ""){
  if(!mqtt.connected()) return;

  String json = "{";
  json += "\"type\":\"" + type + "\"";
  json += ",\"session_id\":" + String(seatSessionId);
  json += ",\"ts_ms\":" + String((uint32_t)millis());
  json += ",\"pir\":" + String(pirDetected ? 1 : 0);

  if(extraJson.length() > 0){
    json += ",";
    json += extraJson;   // extraJson ต้องเป็นรูปแบบ:  "\"key\":123" หรือ "\"key\":\"text\""
  }

  json += "}";

  mqtt.publish(topic_pub.c_str(), json.c_str());
}

// อัปเดตตรรกะนั่ง/ลุก + ส่งแจ้งเตือน
void updateSittingTracker(){
  unsigned long now = millis();

  // อัปเดต motion ล่าสุด
  if(pirDetected){
    seatLastMotionMs = now;

    // เริ่ม session เมื่อเจอ motion ครั้งแรก
    if(!seated){
      seated = true;
      seatSessionStartMs = now;
      seatLastAlertMs = 0;

      seatSessionId = (uint32_t)(now ^ (uint32_t)ESP.getEfuseMac());
      seatStartSent = false;
      if(mqtt.connected()) { publishEvent("session_start"); seatStartSent = true; }
    }
  }

  if(!seated) return;

  // ถ้า MQTT เพิ่งกลับมา ให้ส่ง session_start ที่ค้างไว้
  if(!seatStartSent && mqtt.connected()) { publishEvent("session_start"); seatStartSent = true; }

  // หาย motion นานแค่ไหน
  unsigned long noMotionMs = (now >= seatLastMotionMs) ? (now - seatLastMotionMs) : 0;

  // ถ้าหาย motion เกิน 10 นาที => ลุกจริง => จบ session และรีเซ็ต
  if(noMotionMs >= LEAVE_CONFIRM_MS){
    unsigned long dur = (now >= seatSessionStartMs) ? (now - seatSessionStartMs) : 0;
    publishEvent("session_end", "\"duration_ms\":" + String((uint32_t)dur));

    seated = false;
    seatSessionId = 0;
    seatSessionStartMs = 0;
    seatLastMotionMs = 0;
    seatLastAlertMs = 0;
    seatStartSent = false;
    return;
  }

  // เตือนเมื่อนั่งเกิน 60 นาที (เตือนซ้ำทุก 15 นาทีถ้ายังไม่ลุกจริง)
  unsigned long sitMs = (now >= seatSessionStartMs) ? (now - seatSessionStartMs) : 0;
  if(sitMs >= SIT_ALERT_MS){
    if(seatLastAlertMs == 0 || (now - seatLastAlertMs) >= ALERT_REPEAT_MS){
      seatLastAlertMs = now;

      unsigned long mins = sitMs / 60000UL;
      telegramSend("⏰ นั่งมา " + String(mins) + " นาทีแล้ว\nลุกพักสายตา 2-3 นาที");

      publishEvent("sit_alert",
        "\"sit_minutes\":" + String((uint32_t)mins) +
        ",\"no_motion_ms\":" + String((uint32_t)noMotionMs)
      );
    }
  }
}

// ================= LED STATE =================
#define LED_MQTT  LED_DATA
unsigned long lastWifiBlink = 0;
bool wifiBlinkState = false;
unsigned long mqttPulseUntil = 0;

void ledWrite(int pin, bool on){
#if LED_ACTIVE_LOW
  digitalWrite(pin, on ? LOW : HIGH);
#else
  digitalWrite(pin, on ? HIGH : LOW);
#endif
}

void updateStatusLEDs(){
  // WiFi LED: กระพริบเมื่อยังไม่เชื่อม / ติดค้างเมื่อเชื่อมแล้ว
  if(WiFi.status() == WL_CONNECTED){
    ledWrite(LED_WIFI, true);
  } else {
    if(millis() - lastWifiBlink >= 300){
      lastWifiBlink = millis();
      wifiBlinkState = !wifiBlinkState;
      ledWrite(LED_WIFI, wifiBlinkState);
    }
  }

  // MQTT LED: ติดค้างเมื่อ connected + pulse สั้นตอน publish
  if(mqtt.connected()){
    if(millis() < mqttPulseUntil) ledWrite(LED_MQTT, false);
    else                          ledWrite(LED_MQTT, true);
  } else {
    ledWrite(LED_MQTT, false);
  }
}

// ================= LCD PRINT HELPERS =================
void clearLine(int row){
  lcd.setCursor(0,row);
  for(int i=0;i<20;i++) lcd.print(" ");
}
void printLine(int row, String s){
  if(s.length() > 20) s = s.substring(0,20);
  lcd.setCursor(0,row);
  lcd.print(s);
  for(int i=s.length(); i<20; i++) lcd.print(" ");
}
void printCenter(int row, String s){
  if(s.length() > 20) s = s.substring(0,20);
  clearLine(row);
  int pad = (20 - (int)s.length()) / 2;
  if(pad < 0) pad = 0;
  lcd.setCursor(pad, row);
  lcd.print(s);
}

// ================= ✅ WIFI MANAGER CONNECT =================
// ✅ ปรับใหม่: ไม่รีสตาร์ทเมื่อเชื่อม WiFi ไม่ได้ (เข้าโหมด Offline ได้ทันที)
bool connectWiFi_NoHardcode(){
  WiFi.mode(WIFI_STA);
  pinMode(WIFI_RESET_PIN, INPUT_PULLUP);

  // ตั้งค่า portal/timeout (กันค้างนานเกิน)
  wm.setConfigPortalTimeout(15);   // ลดเวลารอหน้า Portal (กันค้างนาน)
  wm.setConnectTimeout(10);        // เวลาให้ลองเชื่อม WiFi ต่อรอบ
  wm.setConnectRetries(1);          // ลดจำนวนรอบ retry เพื่อเข้า Offline ไวขึ้น

  String apName = "SmartDesk-Setup";

  printLine(0, "WiFi: Auto/Portal");
  printLine(1, "AP: " + apName);
  printLine(2, "If not connect");
  printLine(3, "join AP + set");

  bool ok = wm.autoConnect(apName.c_str());

  if(!ok){
    // ✅ Offline: ไม่ restart / ไม่ block ระบบอื่น
    offlineMode = true;
    WiFi.disconnect(false, true);
    // ไม่ค้างหน้ารอเชื่อม -> ให้ไปแสดงหน้าสถานะอุปกรณ์ทันที (updateLCD ใน setup)
    return false;
  }
  offlineMode = false;
  printLine(0, "WiFi Connected");
  printLine(1, "IP:");
  printLine(2, WiFi.localIP().toString());
  printLine(3, "");
  delay(800);
  return true;
}
// ================= ✅ WIFI RUNTIME (RESET ANYTIME + NON-BLOCKING RECONNECT) =================
void checkWiFiReset(){
  // ✅ กดค้าง 5 วินาที เพื่อ reset WiFi ได้ตลอดเวลา
  static bool wasPressed = false;
  static unsigned long pressStart = 0;

  bool pressed = (digitalRead(WIFI_RESET_PIN) == LOW);
  unsigned long now = millis();

  if(pressed && !wasPressed){
    wasPressed = true;
    pressStart = now;
  }

  if(!pressed && wasPressed){
    wasPressed = false;
    pressStart = 0;
  }

  if(wasPressed && pressStart > 0 && (now - pressStart) >= 5000){
    // ทำครั้งเดียวต่อการกดค้าง
    wasPressed = false;
    pressStart = 0;

    Serial.println("🔄 WiFi reset requested (button hold)");
    printLine(0, "WiFi reset...");
    printLine(1, "Clearing creds");
    printLine(2, "Rebooting...");
    printLine(3, "");
    delay(600);

    wm.resetSettings();               // ล้าง SSID/Password ที่เคยบันทึก
    WiFi.disconnect(true, true);      // ล้างการเชื่อมต่อ + ล้าง config ใน RAM
    delay(200);
    ESP.restart();                    // รีบูตเพื่อเข้า portal ใหม่แบบสะอาด
  }
}

void handleWiFiReconnect(){
  // ✅ ถ้าหลุด WiFi ให้พยายาม reconnect แบบไม่ค้างระบบ
  if(WiFi.status() == WL_CONNECTED) return;

  // ถ้ายังไม่มี credential เลย ก็ไม่ต้อง reconnect ถี่ ๆ (จะอยู่ Offline จนกด reset แล้วตั้งค่า)
  if(WiFi.SSID().length() == 0) return;

  unsigned long now = millis();
  if(now - lastWifiReconnectAttempt >= WIFI_RECONNECT_INTERVAL_MS){
    lastWifiReconnectAttempt = now;
    Serial.println("🔁 Trying WiFi.reconnect()");
    WiFi.reconnect();
  }
}

void handleOfflineAuto(){
  // ✅ เพิ่มอย่างเดียว: ถ้าเข้า Offline ให้เป็น AUTO ทันที
  // ไม่ไปยุ่งส่วนอื่น (MQTT/Relay/Sensor) นอกจากตั้งค่า autoMode
  if(WiFi.status() != WL_CONNECTED){
    if(!forcedAutoOffline){
      autoMode = true;
      forcedAutoOffline = true;
      Serial.println("⚠️ Offline → Force AUTO mode");
    }
  } else {
    forcedAutoOffline = false;
  }
}


// ================= TELEGRAM =================
bool telegramSend(String msg){
  if (WiFi.status() != WL_CONNECTED) return false;
  if (TG_BOT_TOKEN.startsWith("PUT") || TG_CHAT_ID.startsWith("PUT")) return false;

  if (millis() - lastTgSentMs < TG_COOLDOWN_MS) return false;
  lastTgSentMs = millis();

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient https;
  String url = "https://api.telegram.org/bot" + TG_BOT_TOKEN + "/sendMessage";
  https.begin(client, url);
  https.addHeader("Content-Type","application/x-www-form-urlencoded");

  msg.replace("%", "%25");
  msg.replace(" ", "%20");
  msg.replace("\n","%0A");

  String payload = "chat_id=" + TG_CHAT_ID + "&text=" + msg;
  int code = https.POST(payload);
  https.end();

  return (code > 0 && code < 300);
}

// ================= ✅ RELAY (FIXED) =================
// ✅ แก้ให้รองรับ Active-LOW และบังคับสถานะเริ่มต้นได้ถูก
void relayWrite(bool on){
#if RELAY_ACTIVE_LOW
  digitalWrite(RELAY_PIN, on ? LOW : HIGH);
#else
  digitalWrite(RELAY_PIN, on ? HIGH : LOW);
#endif
}

void setRelay(bool on){
  relayOn = on;
  relayWrite(on);
}

// ================= Small JSON extract (ไม่ใช้ lib) =================
String jsonGetString(const String& json, const String& key){
  String pat = "\"" + key + "\"";
  int i = json.indexOf(pat);
  if(i < 0) return "";
  i = json.indexOf(':', i);
  if(i < 0) return "";
  while(i < (int)json.length() && (json[i] == ':' || json[i] == ' ')) i++;
  if(i >= (int)json.length() || json[i] != '\"') return "";
  i++;
  int j = json.indexOf('\"', i);
  if(j < 0) return "";
  return json.substring(i, j);
}

// ================= MQTT =================
void mqttConnect(){
  if (mqtt.connected()) return;
  if (WiFi.status() != WL_CONNECTED) return;

  if (mqtt.connect(clientId.c_str())) {
    mqtt.subscribe(topic_cmd.c_str());
    mqtt.subscribe(topic_lcd_standby.c_str());
    Serial.println("[MQTT] connected + subscribed");
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int len){
  String t = String(topic);
  String msg;
  msg.reserve(len + 8);
  for(unsigned int i=0;i<len;i++) msg += (char)payload[i];
  msg.trim();

  if(t == topic_lcd_standby){
    String l2 = jsonGetString(msg, "line2");
    String l3 = jsonGetString(msg, "line3");
    if(l2.length() > 0 || l3.length() > 0){
      standbyLine2 = l2; standbyLine3 = l3;
      standbyLine2.trim(); standbyLine3.trim();
      if(standbyLine2.length() > 20) standbyLine2 = standbyLine2.substring(0,20);
      if(standbyLine3.length() > 20) standbyLine3 = standbyLine3.substring(0,20);
      lcdView = LCD_STANDBY;
      lastMeaningfulChangeMs = millis();
    }
    return;
  }

  Serial.print("[CMD] "); Serial.println(msg);

  if(msg == "RELAY:ON")  { setRelay(true);  lastMeaningfulChangeMs = millis(); }
  if(msg == "RELAY:OFF") { setRelay(false); lastMeaningfulChangeMs = millis(); }
  if(msg == "AUTO:ON")   { autoMode = true; lastMeaningfulChangeMs = millis(); }
  if(msg == "AUTO:OFF")  { autoMode = false; lastMeaningfulChangeMs = millis(); }

  if(msg == "LCD:CLEAR"){ lcd.clear(); }

  if(msg.startsWith("LCD:STANDBY:")){
    String data = msg.substring(String("LCD:STANDBY:").length());
    int sep = data.indexOf('|');
    if(sep >= 0){
      standbyLine2 = data.substring(0, sep);
      standbyLine3 = data.substring(sep + 1);
    } else {
      standbyLine2 = data; standbyLine3 = "";
    }
    standbyLine2.trim(); standbyLine3.trim();
    if(standbyLine2.length() > 20) standbyLine2 = standbyLine2.substring(0,20);
    if(standbyLine3.length() > 20) standbyLine3 = standbyLine3.substring(0,20);
    lcdView = LCD_STANDBY;
    lastMeaningfulChangeMs = millis();
  }

  if(msg.startsWith("LCD:STABLESEC:")){
    int sec = msg.substring(String("LCD:STABLESEC:").length()).toInt();
    if(sec < 2) sec = 2;
    if(sec > 60) sec = 60;
    stableRequiredMs = (unsigned long)sec * 1000UL;
  }

  if(msg == "LCD:STANDBY:ON")  lcdView = LCD_STANDBY;
  if(msg == "LCD:STANDBY:OFF") lcdView = LCD_LIVE;
}

// ================= SENSOR =================
void readSensors(){
  pirDetected = digitalRead(PIR_PIN);
  ldrValue = analogRead(LDR_PIN);
}

// ================= LOCAL LOGIC =================
void runLogic(){
  if(!autoMode) return;

  if(pirDetected){
    pirLowStart = 0;

    if(!relayOn && ldrValue < LDR_ON_TH){
      setRelay(true);
    }

    if(relayOn && ldrValue > LDR_OFF_TH){
      if(brightStart == 0) brightStart = millis();
      if(millis() - brightStart > BRIGHT_OFF_DELAY){
        setRelay(false);
        brightStart = 0;
      }
    } else {
      brightStart = 0;
    }
  } else {
    brightStart = 0;
    if(pirLowStart == 0) pirLowStart = millis();
    if(millis() - pirLowStart > NO_MOTION_OFF){
      setRelay(false);
    }
  }
}

// ================= Meaningful change detection =================
void detectMeaningfulChange(){
  int curPir   = pirDetected ? 1 : 0;
  int curRelay = relayOn ? 1 : 0;
  int curAuto  = autoMode ? 1 : 0;

  bool ldrChanged = false;
  if(lastLdr == -9999) ldrChanged = true;
  else if(abs(ldrValue - lastLdr) >= LDR_DEADBAND) ldrChanged = true;

  bool changed = false;
  if(lastPir   == -1 || curPir   != lastPir)   changed = true;
  if(lastRelay == -1 || curRelay != lastRelay) changed = true;
  if(lastAuto  == -1 || curAuto  != lastAuto)  changed = true;
  if(ldrChanged) changed = true;

  if(changed){
    lastMeaningfulChangeMs = millis();
    lcdView = LCD_LIVE;
    lastPir   = curPir;
    lastRelay = curRelay;
    lastAuto  = curAuto;
    lastLdr   = ldrValue;
  }
}

// ================= Mode C =================
void applyModeC(){
  if(lcdView == LCD_LIVE){
    if(millis() - lastMeaningfulChangeMs >= stableRequiredMs){
      lcdView = LCD_STANDBY;
    }
  }
}

// ================= LCD =================
void drawStandby(){
  printCenter(0, "== STANDBY MODE ==");
  printCenter(1, standbyLine2);
  printCenter(2, standbyLine3);

  String s = "LAMP:";
  s += (relayOn ? "ON " : "OFF");
  s += " AUTO:";
  s += (autoMode ? "ON" : "OFF");
  printLine(3, s);
}

void drawLive(){
  int pir = pirDetected ? 1 : 0;
  printLine(0, "PIR:" + String(pir) + "  LDR:" + String(ldrValue));
  printLine(1, String("LAMP:") + (relayOn?"ON ":"OFF") + " AUTO:" + (autoMode?"ON":"OFF"));
  printLine(2, String("WiFi:") + (WiFi.status()==WL_CONNECTED?"OK ":"DOWN"));
  printLine(3, "MQTT:" + String(mqtt.connected()?"OK ":"DOWN"));
}

// ===== LCD: Sitting too long alert page (เพิ่มอย่างเดียว ไม่กระทบระบบอื่น) =====
void drawSitAlert(){
  unsigned long now = millis();
  unsigned long sitMs = (seated && now >= seatSessionStartMs) ? (now - seatSessionStartMs) : 0;
  unsigned long mins = sitMs / 60000UL;

  printCenter(0, "!! SIT TOO LONG !!");
  printCenter(1, "TAKE A SHORT BREAK");
  printLine(2, "Time: " + String((uint32_t)mins) + " min");
  printLine(3, "Stand up 2-3 min");
}

void updateLCD(){
  // แสดงหน้าแจ้งเตือน "นั่งนานเกิน" เป็นช่วงๆ (ไม่เปลี่ยน view เดิม)
  // - เงื่อนไข: seated และ sit time >= SIT_ALERT_MS
  // - แสดง 3 วินาที ทุก ๆ 10 วินาที
  const unsigned long LCD_ALERT_SHOW_MS = 3000;
  const unsigned long LCD_ALERT_INTERVAL_MS = 10000;
  static unsigned long lastAlertKickMs = 0;
  static unsigned long alertShowUntilMs = 0;

  static unsigned long lastDraw = 0;
  if(millis() - lastDraw < 250) return;
  lastDraw = millis();

  unsigned long now = millis();
  bool sitTooLong = (seated && now >= seatSessionStartMs && (now - seatSessionStartMs) >= SIT_ALERT_MS);
  if(sitTooLong){
    if((now - lastAlertKickMs) >= LCD_ALERT_INTERVAL_MS){
      lastAlertKickMs = now;
      alertShowUntilMs = now + LCD_ALERT_SHOW_MS;
    }
    if(alertShowUntilMs > now){
      drawSitAlert();
      return;
    }
  }

  if(lcdView == LCD_STANDBY) drawStandby();
  else drawLive();
}

// ================= MQTT SEND (10s) =================
void publishData(){
  if(!mqtt.connected()) return;
  if(millis() - lastMqtt < 10000) return;
  lastMqtt = millis();

  String json = "{";
  json += "\"ldr\":"    + String(ldrValue);
  json += ",\"relay\":" + String(relayOn?1:0);
  json += ",\"pir\":"   + String(pirDetected?1:0);
  json += ",\"auto\":"  + String(autoMode?1:0);
  json += ",\"wifi\":"  + String(WiFi.status()==WL_CONNECTED?1:0);
  json += ",\"rssi\":"  + String(WiFi.RSSI());

  // ✅ seat timing (source of truth = ESP)
  unsigned long nowMs = millis();
  unsigned long sitMs  = (seated && nowMs >= seatSessionStartMs) ? (nowMs - seatSessionStartMs) : 0;
  unsigned long awayMs = (seated && nowMs >= seatLastMotionMs)   ? (nowMs - seatLastMotionMs)   : 0;

  json += ",\"seat\":{";
  json += "\"seated\":" + String(seated ? 1 : 0);
  json += ",\"session_id\":" + String(seatSessionId);
  json += ",\"sit_ms\":" + String((uint32_t)sitMs);
  json += ",\"away_ms\":" + String((uint32_t)awayMs);
  json += ",\"leave_confirm_ms\":" + String((uint32_t)LEAVE_CONFIRM_MS);
  json += "}";
  json += "}";

  mqtt.publish(topic_pub.c_str(), json.c_str());

  // pulse สั้นๆ ให้ LED_MQTT เห็น activity
  mqttPulseUntil = millis() + 60;
}

// ================= NOTIFY =================
void notifyChange(){
  bool wifiOK = (WiFi.status() == WL_CONNECTED);
  bool mqttOK = mqtt.connected();

  if(relayOn != prevRelayNotify){
    telegramSend(relayOn ? "💡 Lamp ON" : "💡 Lamp OFF");
    prevRelayNotify = relayOn;
  }
  if(wifiOK != prevWifiNotify){
    telegramSend(wifiOK ? "📶 WiFi Connected" : "📶 WiFi Lost");
    prevWifiNotify = wifiOK;
  }
  if(mqttOK != prevMqttNotify){
    telegramSend(mqttOK ? "🟢 MQTT Connected" : "🔴 MQTT Lost");
    prevMqttNotify = mqttOK;
  }
}

// ================= SETUP =================
void setup(){
  Serial.begin(115200);

  pinMode(PIR_PIN, INPUT);
  pinMode(RELAY_PIN, OUTPUT);

  pinMode(LED_WIFI, OUTPUT);
  pinMode(LED_DATA, OUTPUT);

  // ✅ สำคัญ: ตั้งค่ารีเลย์ให้ OFF ตั้งแต่เริ่ม (กันรีเลย์กระพริบตอนบูต)
  setRelay(false);

  // LED ดับก่อน
  ledWrite(LED_WIFI, false);
  ledWrite(LED_MQTT, false);

  lcd.init();
  lcd.backlight();
  lcd.clear();

  printLine(0, "Smart Desk Boot...");
  printLine(1, "WiFi: preparing");
  printLine(2, "MQTT waiting...");
  printLine(3, "");
  bool wifiOk = connectWiFi_NoHardcode();
  clientId = "ESP32-SDA-REAL-" + String((uint32_t)ESP.getEfuseMac(), HEX);

  mqtt.setServer(mqtt_server, 1883);
  mqtt.setCallback(mqttCallback);

  prevRelayNotify = relayOn;
  prevWifiNotify  = (WiFi.status()==WL_CONNECTED);
  prevMqttNotify  = false;

  lastMeaningfulChangeMs = millis();
  // ถ้าเข้า Offline ให้แสดงหน้าสถานะอุปกรณ์ทันที ไม่ค้างหน้ารอเชื่อม
  if(!wifiOk || offlineMode){
    lcdView = LCD_LIVE;
  } else {
    lcdView = LCD_STANDBY;
  }
  updateLCD();

  updateStatusLEDs();
}

// ================= LOOP =================
void loop(){
  checkWiFiReset();
  handleWiFiReconnect();
  handleOfflineAuto();

  mqttConnect();
  mqtt.loop();

  readSensors();
  updateSittingTracker();
  runLogic();

  detectMeaningfulChange();
  applyModeC();
  updateLCD();

  publishData();
  notifyChange();

  updateStatusLEDs();

  delay(50);
}