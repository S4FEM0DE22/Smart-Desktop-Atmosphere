#include <WiFi.h>
#include <PubSubClient.h>
#include <LiquidCrystal_I2C.h>

// ================= PINS (WOKWI) =================
#define PIR_PIN   13
#define LDR_PIN   34
#define RELAY_PIN 26

#define LED_WIFI  4
#define LED_DATA  2

// ================= LED POLARITY =================
#define LED_ACTIVE_LOW  0

// ================= RELAY POLARITY =================
#define RELAY_ACTIVE_LOW  1

// ================= LCD =================
LiquidCrystal_I2C lcd(0x27, 20, 4);

// ================= WIFI (WOKWI) =================
const char* ssid = "Wokwi-GUEST";
const char* password = "";

// ================= MQTT =================
const char* mqtt_server = "broker.hivemq.com";
String clientId;

String topic_pub = "smartdesk/ESP32-SDA-WOKWI/telemetry";
String topic_cmd = "smartdesk/ESP32-SDA-WOKWI/cmd";
String topic_lcd_standby = "smartdesk/ESP32-SDA-WOKWI/lcd/standby";

// ================= STATE =================
WiFiClient espClient;
PubSubClient mqtt(espClient);

bool pirDetected = false;
bool relayOn = false;
bool autoMode = true;
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

// ================= SITTING TRACKER =================
// ✅ ปรับได้
const unsigned long LEAVE_CONFIRM_MS  = 30000;  // หาย motion เกิน 30 วินาที = ลุกจริง
const unsigned long SIT_ALERT_MS      = 1UL * 60UL * 1000UL; // นั่งเกิน 1 นาที = เตือน (บันทึก event)
const unsigned long ALERT_REPEAT_MS   = 10000;  // เตือนซ้ำทุก 10 วินาที (บันทึก event)

bool seated = false;
uint32_t seatSessionId = 0;
unsigned long seatSessionStartMs = 0;
unsigned long seatLastMotionMs   = 0;
unsigned long seatLastAlertMs    = 0;
bool seatStartSent = false;

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

// ================= RELAY =================
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

void publishEvent(const String& type, const String& extraJson = ""){
  if(!mqtt.connected()) return;

  String json = "{";
  json += "\"type\":\"" + type + "\"";
  json += ",\"session_id\":" + String(seatSessionId);
  json += ",\"ts_ms\":" + String((uint32_t)millis());
  json += ",\"pir\":" + String(pirDetected ? 1 : 0);

  if(extraJson.length() > 0){
    json += ",";
    json += extraJson;
  }
  json += "}";

  mqtt.publish(topic_pub.c_str(), json.c_str());
  mqttPulseUntil = millis() + 60;
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
      publishEvent("lcd_standby_update",
        "\"line2\":\"" + standbyLine2 + "\",\"line3\":\"" + standbyLine3 + "\""
      );
    }
    return;
  }

  Serial.print("[CMD] "); Serial.println(msg);

  if(msg == "RELAY:ON")  { setRelay(true);  lastMeaningfulChangeMs = millis(); publishEvent("cmd", "\"value\":\"RELAY:ON\""); }
  if(msg == "RELAY:OFF") { setRelay(false); lastMeaningfulChangeMs = millis(); publishEvent("cmd", "\"value\":\"RELAY:OFF\""); }
  if(msg == "AUTO:ON")   { autoMode = true; lastMeaningfulChangeMs = millis(); publishEvent("cmd", "\"value\":\"AUTO:ON\""); }
  if(msg == "AUTO:OFF")  { autoMode = false; lastMeaningfulChangeMs = millis(); publishEvent("cmd", "\"value\":\"AUTO:OFF\""); }

  if(msg == "LCD:CLEAR"){ lcd.clear(); publishEvent("cmd", "\"value\":\"LCD:CLEAR\""); }
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

// ================= Sitting Tracker =================
void updateSittingTracker(){
  unsigned long now = millis();

  if(pirDetected){
    seatLastMotionMs = now;

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

  if(!seatStartSent && mqtt.connected()) { publishEvent("session_start"); seatStartSent = true; }

  unsigned long noMotionMs = (now >= seatLastMotionMs) ? (now - seatLastMotionMs) : 0;

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

  unsigned long sitMs = (now >= seatSessionStartMs) ? (now - seatSessionStartMs) : 0;
  if(sitMs >= SIT_ALERT_MS){
    if(seatLastAlertMs == 0 || (now - seatLastAlertMs) >= ALERT_REPEAT_MS){
      seatLastAlertMs = now;

      unsigned long mins = sitMs / 60000UL;

      // ✅ ตัด Telegram แล้ว แต่ยังส่ง event/log ให้ระบบจริงได้
      publishEvent("sit_alert",
        "\"sit_minutes\":" + String((uint32_t)mins) +
        ",\"no_motion_ms\":" + String((uint32_t)noMotionMs)
      );
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

void updateLCD(){
  static unsigned long lastDraw = 0;
  if(millis() - lastDraw < 250) return;
  lastDraw = millis();
  if(lcdView == LCD_STANDBY) drawStandby();
  else drawLive();
}

// ================= MQTT SEND (10s) =================
void publishData(){
  if(!mqtt.connected()) return;
  if(millis() - lastMqtt < 10000) return;
  lastMqtt = millis();

  // ✅ seat timing (source of truth = ESP)
  unsigned long nowMs = millis();
  unsigned long sitMs  = (seated && nowMs >= seatSessionStartMs) ? (nowMs - seatSessionStartMs) : 0;
  unsigned long awayMs = (seated && nowMs >= seatLastMotionMs)   ? (nowMs - seatLastMotionMs)   : 0;

  String json = "{";
  json += "\"ldr\":"    + String(ldrValue);
  json += ",\"relay\":" + String(relayOn?1:0);
  json += ",\"pir\":"   + String(pirDetected?1:0);
  json += ",\"auto\":"  + String(autoMode?1:0);
  json += ",\"wifi\":"  + String(WiFi.status()==WL_CONNECTED?1:0);
  json += ",\"rssi\":"  + String(WiFi.RSSI());

  json += ",\"seat\":{";
  json += "\"seated\":" + String(seated ? 1 : 0);
  json += ",\"session_id\":" + String(seatSessionId);
  json += ",\"sit_ms\":" + String((uint32_t)sitMs);
  json += ",\"away_ms\":" + String((uint32_t)awayMs);
  json += ",\"leave_confirm_ms\":" + String((uint32_t)LEAVE_CONFIRM_MS);
  json += "}";

  json += "}";

  mqtt.publish(topic_pub.c_str(), json.c_str());
  mqttPulseUntil = millis() + 60;
}

// ================= WIFI CONNECT (WOKWI SIMPLE) =================
void connectWiFi_Wokwi(){
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  printLine(0, "WiFi connecting...");
  unsigned long t0 = millis();
  while(WiFi.status() != WL_CONNECTED && millis() - t0 < 15000){
    delay(250);
  }

  if(WiFi.status() == WL_CONNECTED){
    printLine(0, "WiFi Connected");
    printLine(1, "IP:");
    printLine(2, WiFi.localIP().toString());
    printLine(3, "");
  } else {
    printLine(0, "WiFi FAIL");
    printLine(1, "Check Wokwi net");
    printLine(2, "");
    printLine(3, "");
  }
  delay(700);
}

// ================= SETUP =================
void setup(){
  Serial.begin(115200);

  pinMode(PIR_PIN, INPUT);
  pinMode(RELAY_PIN, OUTPUT);

  pinMode(LED_WIFI, OUTPUT);
  pinMode(LED_DATA, OUTPUT);

  setRelay(false);
  ledWrite(LED_WIFI, false);
  ledWrite(LED_MQTT, false);

  lcd.init();
  lcd.backlight();
  lcd.clear();

  printLine(0, "Smart Desk Boot...");
  printLine(1, "Wokwi");
  printLine(2, "MQTT waiting...");
  printLine(3, "");

  connectWiFi_Wokwi();

  clientId = "ESP32-SDA-WOKWI-" + String((uint32_t)ESP.getEfuseMac(), HEX);

  mqtt.setServer(mqtt_server, 1883);
  mqtt.setCallback(mqttCallback);

  lastMeaningfulChangeMs = millis();
  lcdView = LCD_STANDBY;

  updateLCD();
  updateStatusLEDs();
}

// ================= LOOP =================
void loop(){
  mqttConnect();
  mqtt.loop();

  readSensors();
  updateSittingTracker();
  runLogic();

  detectMeaningfulChange();
  applyModeC();
  updateLCD();

  publishData();
  updateStatusLEDs();

  delay(50);
}