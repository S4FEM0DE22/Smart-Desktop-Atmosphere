# 📖 คู่มือผู้ใช้ - สมาร์ต เดสก์ท็อป แอตโมสเฟียร์

---

## 📋 สารบัญ

1. [ภาพรวมระบบ](#ภาพรวมระบบ)
2. [ฮาร์ดแวร์และการต่อเสริม](#ฮาร์ดแวร์และการต่อเสริม)
3. [สถาปัตยกรรมระบบ](#สถาปัตยกรรมระบบ)
4. [คุณสมบัติหลัก](#คุณสมบัติหลัก)
5. [การติดตั้งและตั้งค่า](#การติดตั้งและตั้งค่า)
6. [การใช้งานแดชบอร์ด](#การใช้งานแดชบอร์ด)
7. [API Endpoints](#api-endpoints)
8. [การตั้งค่า MQTT Commands](#การตั้งค่า-mqtt-commands)
9. [จอ LCD Display](#จอ-lcd-display)
10. [การแก้ปัญหา](#การแก้ปัญหา)
11. [คำศัพท์เทคนิค](#คำศัพท์เทคนิค)

---

## 🎯 ภาพรวมระบบ

**สมาร์ต เดสก์ท็อป แอตโมสเฟียร์** เป็นระบบ IoT ที่ออกแบบเพื่อ:

- **ตรวจสอบการปรากฏตัวที่โต๊ะ** ผ่านเซนเซอร์ PIR (ตรวจจับการเคลื่อนไหว)
- **ปรับความสว่าง** ตามเงื่อนไขแสง (LDR) และการเคลื่อนไหว
- **ควบคุมแสงสว่างอัตโนมัติ** ผ่านโมดูลรีเลย์
- **ติดตามเวลาการนั่ง** และส่งการแจ้งเตือนเมื่อนั่งนานเกินไป
- **บันทึกข้อมูล** ลงฐานข้อมูล SQLite เพื่อการวิเคราะห์ในอนาคต
- **แสดงข้อมูลแบบเรียลไทม์** บนแดชบอร์ดเว็บ

### 🏗️ ระบบหลัก

```
┌─────────────────────────────────────────────────────────────┐
│                    ESP32 (ฮาร์ดแวร์)                        │
│  ┌─────────────┬──────────┬──────────┬─────────────────┐   │
│  │ PIR Sensor  │ LDR      │ Relay    │ LCD 20x4        │   │
│  │ (GPIO 13)   │ (GPIO 34)│ (GPIO26) │ (I2C: 0x27)    │   │
│  └─────────────┴──────────┴──────────┴─────────────────┘   │
│         ↑              ↑              ↓                       │
│    [สัญญาณ]       [สัญญาณ]      [ควบคุม]                   │
└─────────────────────────────────────────────────────────────┘
             ↓ WiFi / MQTT
┌─────────────────────────────────────────────────────────────┐
│          MQTT Broker (HiveMQ - Cloud)                       │
│          Endpoint: broker.hivemq.com:1883                  │
└─────────────────────────────────────────────────────────────┘
             ↓ Subscribe / Publish
┌─────────────────────────────────────────────────────────────┐
│      Node.js Server (server_real หรือ server_wokwi)        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ • Express.js (API Server)                           │  │
│  │ • SQLite Database (data.db)                         │  │
│  │ • MQTT Client (รับ/ส่งข้อมูล)                      │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
             ↓ HTTP
┌─────────────────────────────────────────────────────────────┐
│           Web Dashboard (http://localhost:3000)            │
│  ┌────────────────────────────────────────────────────┐   │
│  │ • Real-time Status Display                        │   │
│  │ • Line Charts (PIR, LDR, Relay, WiFi)           │   │
│  │ • Sitting Time Tracker                           │   │
│  │ • Telemetry Database Viewer                      │   │
│  │ • Manual Relay Control                           │   │
│  └────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔌 ฮาร์ดแวร์และการต่อเสริม

### อุปกรณ์ที่จำเป็น

| อุปกรณ์ | รุ่น | จำนวน | หน้าที่ |
|--------|-----|-------|---------|
| **Microcontroller** | ESP32 (NodeMCU-32S) | 1 | ประมวลผลกลาง |
| **Motion Sensor** | PIR HC-SR501 | 1 | ตรวจจับการเคลื่อนไหว |
| **Light Sensor** | LDR (Photo Resistor) | 1 | ตรวจจับความสว่าง |
| **Relay Module** | 5V/1-Channel Relay | 1 | ควบคุมโคมไฟ |
| **LED สถานะ** | LED 5mm | 2 | แสดงสถานะ WiFi/MQTT |
| **LCD Display** | 20x4 I2C LCD | 1 | แสดงข้อมูลแบบเรียลไทม์ |
| **WiFi สำหรับ Reset** | Pushbutton | 1 | ล้าง WiFi Config |
| **Power Supply** | USB 5V 2A | 1 | จ่ายไฟให้ระบบ |
| **Resistors** | 10kΩ, 220Ω | 4 | Pullup/ป้องกัน |

### Pinout (การต่อสาย)

```
ESP32 GPIO Pins:
┌──────────────────────────────┐
│  GPIO 13 ─ PIR Sensor Data   │
│  GPIO 34 ─ LDR (ADC Input)   │
│  GPIO 26 ─ Relay IN (Signal) │
│  GPIO 2  ─ WiFi LED          │
│  GPIO 4  ─ MQTT LED          │
│  GPIO 16 ─ WiFi Reset Button │
│  GPIO 21 ─ I2C SDA (LCD)     │
│  GPIO 22 ─ I2C SCL (LCD)     │
│  GND    ─ Ground (ทั้งหมด)  │
│  5V     ─ Power (ทั้งหมด)   │
└──────────────────────────────┘
```

### การต่อสายรายละเอียด

**PIR Sensor (GPIO 13)**
```
PIR OUT ──→ GPIO 13
PIR GND ──→ GND
PIR VCC ──→ 5V
```

**LDR (GPIO 34)**
```
LDR Pin 1 ──→ 3.3V (ผ่าน 10kΩ)
LDR Pin 2 ──→ GPIO 34 (ADC)
LDR Pin 2 ──→ GND (ผ่าน 10kΩ)
```

**Relay Module (GPIO 26)**
```
Relay IN  ──→ GPIO 26
Relay GND ──→ GND
Relay VCC ──→ 5V
Relay COM ──→ Light Switch Line
Relay NO  ──→ Light Circuit
```

**Status LEDs (GPIO 2 & 4)**
```
GPIO 2 ──→ WiFi LED Anode
GPIO 4 ──→ MQTT LED Anode
GND    ──→ LED Cathode (ผ่าน 100Ω Resistor)
```

**LCD I2C (GPIO 21/22)**
```
LCD SDA ──→ GPIO 21
LCD SCL ──→ GPIO 22
LCD GND ──→ GND
LCD VCC ──→ 5V
I2C Address: 0x27
```

**WiFi Reset Button (GPIO 16)**
```
Button Pin 1 ──→ GPIO 16
Button Pin 2 ──→ GND
กด 5 วิเพื่อล้าง WiFi Settings
```

---

## 🏛️ สถาปัตยกรรมระบบ

### การไหลของข้อมูล (Data Flow)

```
1. Hardware Layer (ESP32)
   ├─ PIR Sensor → ตรวจจับการเคลื่อนไหว
   ├─ LDR Sensor → ตรวจจับความสว่าง
   ├─ LCD Display ← ได้รับคำสั่งจากเซิร์ฟเวอร์
   └─ Relay ← ควบคุมจากตรรมชาติของ PIR/LDR

2. Communication Layer (WiFi + MQTT)
   ├─ ESP32 Publish Topics:
   │  ├─ smartdesk/ESP32-SDA-REAL/telemetry
   │  └─ smartdesk/ESP32-SDA-REAL/relay/state
   ├─ ESP32 Subscribe Topics:
   │  ├─ smartdesk/ESP32-SDA-REAL/cmd
   │  └─ smartdesk/ESP32-SDA-REAL/lcd/standby
   └─ Broker: broker.hivemq.com:1883

3. Server Layer (Node.js)
   ├─ Receive MQTT → Parse JSON
   ├─ Store in SQLite Database
   ├─ REST API for Web Dashboard
   └─ Send Commands via MQTT

4. Presentation Layer (Web Browser)
   ├─ Real-time Dashboard
   ├─ Interactive Controls
   ├─ Historical Charts
   └─ Sitting Time Analytics
```

### Database Schema (SQLite)

```sql
-- บันทึกค่าเซนเซอร์ทุก 10 วิ
CREATE TABLE telemetry (
  id INTEGER PRIMARY KEY,
  ts INTEGER,           -- Timestamp (ms since epoch)
  pir INTEGER,         -- 0/1 (motion detected)
  ldr INTEGER,         -- 0-4095 (light value)
  relay INTEGER,       -- 0/1 (lamp on/off)
  auto INTEGER,        -- 0/1 (auto mode on/off)
  wifi INTEGER,        -- 0/1 (WiFi connected)
  rssi INTEGER         -- Signal strength (-99 to -30 dBm)
);

-- บันทึกเหตุการณ์สำคัญ
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts INTEGER,          -- Timestamp
  type TEXT,           -- session_start, session_end, sit_alert, RELAY_CHANGE, etc.
  detail TEXT          -- JSON detail
);

-- บันทึกข้อความ LCD
CREATE TABLE lcd_messages (
  id INTEGER PRIMARY KEY,
  ts INTEGER,          -- Timestamp
  line2 TEXT,         -- Line 2 message
  line3 TEXT,         -- Line 3 message
  source TEXT         -- 'server' หรือ 'esp'
);

-- บันทึกเซสชันการนั่ง
CREATE TABLE sitting_sessions (
  id INTEGER PRIMARY KEY,
  ts_start INTEGER,    -- เวลาเริ่มนั่ง
  ts_end INTEGER,      -- เวลาหยุดนั่ง
  duration_ms INTEGER, -- ระยะเวลา (milliseconds)
  session_id INTEGER   -- Session ID from ESP
);
```

---

## ⚡ คุณสมบัติหลัก

### 1️⃣ ควบคุมแสงอัตโนมัติ (AUTO Mode)

ระบบอัตโนมัติตัดสินใจเปิด/ปิดแสงตามเงื่อนไขต่อไปนี้:

#### **เปิดแสง**: เมื่อ
- ✅ ตรวจจับการเคลื่อนไหว (PIR = 1) **และ**
- ✅ ความสว่างต่ำ (LDR < 1500)

#### **ปิดแสง**: เมื่อ
- ✅ ไม่มีการเคลื่อนไหว > 30 วิ **หรือ**
- ✅ มีการเคลื่อนไหว และความสว่างสูงมากเพียงพอ (LDR > 1800) เป็นเวลา 5 วิ

#### **ตัวอย่างสถานการณ์**
```
14:00 ← เวลา: ไม่มีผู้คน
└─ Relay: OFF, Auto Mode: ON

14:05 ← เวลา: ผู้ใช้เข้าหาโต๊ะ, ห้องมืด
└─ PIR: 1 (detected) + LDR: 800 (dark)
└─ Relay: ON ✅ (เปิดไฟ)

14:10 ← เวลา: ผู้ใช้รออยู่ที่โต๊ะ
└─ PIR: 0 (no motion for 5 sec) + LDR: 800
└─ Relay: ON (ยังเปิดเพราะเมื่อ 4 วินาทีที่แล้ว LED > 1800)

14:12 ← เวลา: ผู้ใช้ลุกออกจากโต๊ะ
└─ PIR: 0 (no motion for 30+ sec)
└─ Relay: OFF ✅ (ปิดไฟอัตโนมัติ)
```

### 2️⃣ ตัวติดตามเวลาการนั่ง (Sitting Tracker)

ระบบติดตามและบันทึกการนั่งของผู้ใช้:

#### **Event Log ที่ส่ง**

| Event | Trigger | Detail |
|-------|---------|--------|
| `session_start` | PIR ตรวจจับการเคลื่อนไหวครั้งแรก | Session ID, Timestamp |
| `session_end` | ไม่มีการเคลื่อนไหว > 30 วิ | Duration, Session ID |
| `sit_alert` | นั่ง > 60 วิ | Current sitting time |

#### **การแจ้งเตือน**

- 📲 **Telegram Message**: ส่งทุก 5 วิเมื่อนั่ง > 60 วิ
  ```
  "🪑 นั่งนานแล้ว: 2 นาที 15 วิ
   💡 ลุกขึ้นเดินเล่นสักครู่"
  ```
  
- 📺 **LCD Message**: แสดงบนจอ LCD ทุก 10 วิ
  ```
  !! SIT TOO LONG !!
  TAKE A SHORT BREAK
  Time: 2 min
  Stand up 2-3 min
  ```

#### **ตัวอย่าง**
```
14:00:00 ← PIR ตรวจจับ
└─ Event: session_start (session_id=1)

14:01:00 ← นั่งมาแล้ว 60 วิ
└─ Event: sit_alert (duration_ms=60000)
└─ Telegram: "🪑 นั่งนานแล้ว: 1 นาที"

14:01:05 ← นั่งมาแล้ว 65 วิ
└─ Event: sit_alert (ส่งซ้ำ)
└─ Telegram: "🪑 นั่งนานแล้ว: 1 นาที 5 วิ"

14:05:00 ← ไม่มี PIR > 30 วิ
└─ Event: session_end (duration_ms=300000)
└─ DB Insert: sitting_sessions (duration=300s)
```

### 3️⃣ แสดงข้อมูลแบบเรียลไทม์

**Telemetry Publishing**
- 🔄 ESP32 ส่งข้อมูล ทุก **10 วิ**
- 📊 บันทึก JSON:
  ```json
  {
    "pir": 1,
    "ldr": 1234,
    "relay": 1,
    "auto": 1,
    "wifi": 1,
    "rssi": -45,
    "seat": {
      "seated": 1,
      "session_id": 5,
      "sit_ms": 125000,
      "away_ms": 0
    }
  }
  ```

### 4️⃣ โหมด Offline (ทำงานโดยไม่มีอินเทอร์เน็ต)

เมื่อ WiFi หลุด:
- ✅ ระบบยังคงทำงานปกติ
- ✅ ควบคุมแสงอัตโนมัติได้เหมือนเดิม
- ✅ LCD แสดงข้อความ "WiFi: OFFLINE"
- 🔄 เมื่อ WiFi ฟื้นขึ้น ส่งข้อมูลทั้งหมดไปยังเซิร์ฟเวอร์

### 5️⃣ การแจ้งเตือนผ่าน Telegram

| เหตุการณ์ | ข้อความ | Icon |
|----------|--------|------|
| เปิดแสง | "💡 โคมไฟ: เปิด" | 💡 |
| ปิดแสง | "💡 โคมไฟ: ปิด" | ❌ |
| WiFi เชื่อม | "📶 WiFi: เชื่อมต่อแล้ว" | 📶 |
| WiFi หลุด | "📴 WiFi: ขาด" | 📴 |
| MQTT เชื่อม | "🟢 MQTT: เชื่อมต่อแล้ว" | 🟢 |
| MQTT หลุด | "🔴 MQTT: ขาด" | 🔴 |

**Cooldown**: 1.2 วิ (ป้องกันสแปม)

---

## 🚀 การติดตั้งและตั้งค่า

### ขั้นตอนที่ 1: ติดตั้ง Hardware

1. **ต่อเสริมอุปกรณ์** ตามแผนภาพ [ดู: Pinout](#pinout-การต่อสาย)
2. **ตรวจสอบการเชื่อมต่อ** ทั้งหมดก่อนจ่ายไฟ
3. **จ่ายไฟ** ผ่าน USB 5V

### ขั้นตอนที่ 2: ติดตั้ง ESP32 Firmware

#### ผ่าน Arduino IDE

1. ติดตั้ง Arduino IDE (https://www.arduino.cc/en/software)
2. ติดตั้ง ESP32 Board:
   - File → Preferences
   - Board Manager URLs: `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
   - Tools → Board Manager → ค้นหา "esp32" → ติดตั้ง
3. ติดตั้ง Libraries:
   - Sketch → Include Library → Manage Libraries
   - ค้นหาและติดตั้ง:
     - `PubSubClient` (MQTT)
     - `LiquidCrystal_I2C` (LCD)
     - `WiFiManager` (WiFi Configuration)
4. เปิด `esp/SmartDesktop.ino`
5. ตั้งค่า:
   - **Board**: ESP32 Dev Module
   - **Port**: COM## (ตรวจสอบ Device Manager)
   - **Upload Speed**: 921600
6. Click "Upload" ⬆️

#### ผ่าน Wokwi (สำหรับการทดสอบจำลอง)

1. ไปที่ https://wokwi.com/projects/456402689542281217
2. คลิก "Edit"
3. เปลี่ยน Firmware
4. คลิก "Save" แล้ว "Run"

### ขั้นตอนที่ 3: ติดตั้ง Node.js Server

```bash
# 1. ติดตั้ง Node.js (ถ้ายังไม่มี)
# ดาวน์โหลดจาก https://nodejs.org/

# 2. เปิด Terminal/PowerShell ไปยังโฟลเดอร์เซิร์ฟเวอร์
cd C:\Users\safem\Downloads\Smart-Desktop-Atmosphere\server_real

# 3. ติดตั้ง Dependencies
npm install

# 4. เริ่มเซิร์ฟเวอร์
npm start

# Output ควรแสดง:
# [MQTT] connected
# Server running on http://localhost:3000
```

### ขั้นตอนที่ 4: เข้าถึงแดชบอร์ด

1. เปิดเบราว์เซอร์
2. ไปที่ `http://localhost:3000`
3. ควรเห็น:
   - ⚫ ESP32 Connection: "Waiting for ESP32..."
   - ดำเนินการต่อเมื่อ ESP32 เชื่อม

### ขั้นตอนที่ 5: ตั้งค่า WiFi (ครั้งแรก)

1. **ESP32 กำลังรอ WiFi Connection**
   - จอ LCD แสดง "Waiting for WiFi"
   - LED WiFi กระพริบ
2. **เลือก WiFi Network**
   - ค้นหา "SmartDesk-SETUP" บน WiFi ของคุณ
   - เชื่อมต่อ (ไม่มีรหัสผ่าน)
3. **ป้อน WiFi Credentials**
   - ไปที่ `192.168.4.1`
   - เลือก SSID ของ WiFi จริง
   - ป้อนรหัสผ่าน
   - คลิก "Save"
4. **ESP32 เชื่อมต่อ**
   - LED WiFi ติดค้าง
   - เซิร์ฟเวอร์ show "ESP32 Connected" ✅

### ขั้นตอนที่ 6: ตั้งค่า Telegram (ตัวเลือก)

1. สร้าง Telegram Bot:
   - Chat กับ @BotFather บน Telegram
   - ส่ง `/newbot`
   - ตั้งชื่อและเลือก Username
   - คัดลอก **Bot Token**
2. หา Chat ID:
   - Chat กับ @RawDataBot บน Telegram
   - คัดลอก `chat.id`
3. อัปเดต SmartDesktop.ino:
   ```cpp
   String TG_BOT_TOKEN = "xxxxxx:xxxxxxxxxxx"; // Bot Token
   String TG_CHAT_ID   = "1234567890";        // Chat ID
   ```
4. Upload firmware ใหม่

---

## 🖥️ การใช้งานแดชบอร์ด

### หน้าหลัก (Dashboard)

#### **Status Section**
```
📈 Smart Desktop Atmosphere Dashboard

🟢 ESP32 Connected     ← สถานะการเชื่อมต่อ

💡 Relay (Lamp)       🤖 Mode           🛜 WiFi
├─ ON / OFF            ├─ AUTO / MANUAL   └─ Connected / Disconnected

📊 Latest Status      ← ข้อมูลเซนเซอร์ล่าสุด
├─ PIR: 1 (Motion detected)
├─ LDR: 1234 (Dark)
├─ Relay: ON (Lamp on)
├─ Auto Mode: ON
└─ WiFi: Connected (RSSI: -45 dBm)

📈 History Charts     ← กราฟ 30 ข้อมูลล่าสุด
├─ PIR over time
├─ LDR over time
└─ Relay state

🪑 Sitting Time       ← ข้อมูลการนั่งย้อนหลัง 7 วัน
└─ Duration per session
```

#### **Control Buttons**

| Button | ฟังก์ชัน | ผลลัพธ์ |
|--------|---------|--------|
| 💡 ON | เปิดโคมไฟ | ส่ง MQTT: RELAY:ON |
| 💡 OFF | ปิดโคมไฟ | ส่ง MQTT: RELAY:OFF |
| 🤖 AUTO | เปิดโหมดอัตโนมัติ | ส่ง MQTT: AUTO:ON |
| 🔧 MANUAL | ปิดโหมดอัตโนมัติ | ส่ง MQTT: AUTO:OFF |

### หน้า Telemetry Database

**Path**: http://localhost:3000/table.html

#### **ตารางข้อมูลเซนเซอร์**

| เวลา | PIR | LDR | Relay | Auto | WiFi | RSSI |
|-----|-----|-----|-------|------|------|------|
| 14:00:15 | 1 | 1234 | 1 | 1 | 1 | -45 |
| 14:00:25 | 1 | 1100 | 1 | 1 | 1 | -48 |
| 14:00:35 | 0 | 2000 | 1 | 1 | 1 | -45 |

#### **ฟังก์ชัน**
- 📥 โหลดข้อมูลใหม่
- 💾 ส่งออก CSV
- 🔍 ค้นหาตามเวลา

### หน้า LCD Log

**Path**: http://localhost:3000/lcd_log.html

#### **ประวัติข้อความ LCD**

| เวลา | Line 2 | Line 3 |
|-----|--------|--------|
| 14:00:15 | "My Smart Desktop" | "Waiting for change" |
| 14:00:35 | "PIR:1  LDR:1234" | "LAMP:ON AUTO:ON" |

### หน้า Sitting Time

**Path**: http://localhost:3000/sitting.html

#### **ประวัติเซสชันการนั่ง**

| ลำดับ | เริ่มเวลา | สิ้นสุด | ระยะเวลา | Session ID |
|------|---------|--------|---------|-----------|
| 1 | 14:00:15 | 14:05:32 | 5:17 | 1 |
| 2 | 14:10:00 | 14:18:45 | 8:45 | 2 |

#### **สถิติรวม**
- ⏱️ เวลารวมการนั่ง
- 📊 จำนวนเซสชัน
- 📈 กราฟแสดงเวลาการนั่งตามวัน

---

## 🔌 API Endpoints

### Base URL
```
http://localhost:3000
```

### ข้อมูล Telemetry

#### `GET /api/telemetry/latest`
**ดึงข้อมูลล่าสุด**

Response:
```json
{
  "id": 1234,
  "ts": 1708000015123,
  "pir": 1,
  "ldr": 1234,
  "relay": 1,
  "auto": 1,
  "wifi": 1,
  "rssi": -45
}
```

#### `GET /api/telemetry/history?limit=30&since=<timestamp>`
**ดึงข้อมูลย้อนหลัง**

Query Parameters:
- `limit`: จำนวนรายการ (default: 30, max: 1000)
- `since`: Timestamp ตั้งแต่เดือนที่ 1 (optional)

Response:
```json
[
  { "id": 1234, "ts": 1708000015123, "pir": 1, ... },
  { "id": 1233, "ts": 1708000005123, "pir": 1, ... }
]
```

### ข้อมูล Events

#### `GET /api/events?limit=50`
**ดึงเหตุการณ์**

Response:
```json
[
  {
    "id": 1,
    "ts": 1708000015123,
    "type": "session_start",
    "detail": "{\"session_id\": 5}"
  },
  {
    "id": 2,
    "ts": 1708000305123,
    "type": "session_end",
    "detail": "{\"duration_ms\": 290000, \"session_id\": 5}"
  }
]
```

### ข้อมูล LCD Messages

#### `GET /api/lcd/messages?limit=50`
**ดึงข้อความ LCD**

Response:
```json
[
  {
    "id": 1,
    "ts": 1708000015123,
    "line2": "My Smart Desktop",
    "line3": "Waiting for change",
    "source": "server"
  }
]
```

### ข้อมูล Sitting Sessions

#### `GET /api/sitting/sessions?limit=30&days=7`
**ดึงเซสชันการนั่ง**

Query Parameters:
- `limit`: จำนวนรายการ (default: 30)
- `days`: ย้อนหลังกี่วัน (default: 7)

Response:
```json
[
  {
    "id": 1,
    "ts_start": 1708000015123,
    "ts_end": 1708000305123,
    "duration_ms": 290000,
    "session_id": 5
  }
]
```

### ส่งคำสั่ง

#### `POST /api/cmd`
**ส่งคำสั่งไปยัง ESP32**

Headers:
```
X-Admin-Key: 1234
Content-Type: application/json
```

Body:
```json
{
  "cmd": "RELAY:ON"
}
```

Response (Success):
```json
{
  "ok": true,
  "cmd": "RELAY:ON",
  "result": "Command sent"
}
```

Response (Error):
```json
{
  "ok": false,
  "error": "Invalid cmd"
}
```

---

## ⚙️ การตั้งค่า MQTT Commands

### Command Format

ส่งขึ้นไปยัง Topic:
```
smartdesk/ESP32-SDA-REAL/cmd
```

### Available Commands

#### **Relay Control**

| Command | ผลลัพธ์ |
|---------|--------|
| `RELAY:ON` | เปิดโคมไฟ |
| `RELAY:OFF` | ปิดโคมไฟ |

Example:
```bash
mosquitto_pub -h broker.hivemq.com -t "smartdesk/ESP32-SDA-REAL/cmd" -m "RELAY:ON"
```

#### **Auto Mode Control**

| Command | ผลลัพธ์ |
|---------|--------|
| `AUTO:ON` | เปิดโหมดอัตโนมัติ |
| `AUTO:OFF` | ปิดโหมดอัตโนมัติ (ใช้ manual relay control) |

#### **LCD Control**

**LCD Clear**
```
LCD:CLEAR
```

**LCD Standby Content**
```
LCD:STANDBY:Line 2 Text|Line 3 Text
```

Example:
```
LCD:STANDBY:Welcome!|Smart Desk
```

**LCD Stable Duration** (วินาที)
```
LCD:STABLESEC:10
```
(โต้งว่าจอ LCD จะกลับเป็น STANDBY หลังจากไม่มีการเปลี่ยนแปลง 10 วิ)

---

## 🖥️ จอ LCD Display

จอ LCD 20x4 (20 ตัวอักษร × 4 แถว) แสดงข้อมูลแบบไดนามิก:

### โหมด STANDBY (ข้อมูลช่วงพัก)

**เมื่อ**: ไม่มีการเปลี่ยนแปลงสำคัญมา 10 วิ

```
Line 1: == STANDBY MODE ==
Line 2: [Custom message from server]
Line 3: LAMP:ON AUTO:ON
Line 4: [WiFi/MQTT status]
```

Example:
```
== STANDBY MODE ==
My Smart Desktop
LAMP:OFF AUTO:ON
WiFi:OK MQTT:OK
```

### โหมด LIVE (แสดงเซนเซอร์แบบเรียลไทม์)

**เมื่อ**: มีการเปลี่ยนแปลง PIR/LDR/Relay/Auto Mode

ปรับปรุงทุก 250 มิลลิวินาที:

```
Line 1: PIR:1  LDR:1234
Line 2: LAMP:ON AUTO:ON
Line 3: WiFi:OK
Line 4: MQTT:OK
```

### โหมด Alert (แจ้งเตือนนั่งนาน)

**เมื่อ**: นั่ง > 60 วิ

แสดง 3 วิ ทุก ๆ 10 วิ:

```
Line 1: !! SIT TOO LONG !!
Line 2: TAKE A SHORT BREAK
Line 3: Time: 2 min 15 sec
Line 4: Stand up 2-3 min
```

---

## 🔧 การแก้ปัญหา

### ❌ ESP32 ไม่เชื่อมต่อกับ WiFi

**สาเหตุที่อาจเป็น:**
- 🔐 รหัสผ่าน WiFi ผิด
- 📡 WiFi ยังไม่ออนไลน์
- 🔌 ไม่มีไฟฟ้า

**วิธีแก้:**
1. ตรวจสอบ SSID/Password
2. รีเซ็ต WiFi:
   - กดปุ่ม GPIO 16 ไว้ > 5 วิ
   - LCD แสดง "Waiting for WiFi"
   - เชื่อมต่อกับ "SmartDesk-SETUP" ใหม่
3. Reboot ESP32

### ❌ MQTT ไม่เชื่อมต่อ

**สาเหตุที่อาจเป็น:**
- 🌐 ไม่มีอินเทอร์เน็ต
- 🔌 Broker ล่ม
- 🔐 Credentials ผิด

**วิธีแก้:**
1. ตรวจสอบอินเทอร์เน็ต
2. ตรวจสอบ broker URL: `broker.hivemq.com:1883`
3. ดูที่ Serial Monitor:
   ```
   [MQTT] Connecting to broker.hivemq.com...
   [MQTT] connected ✓
   ```

### ❌ แดชบอร์ดแสดง "ESP32 Disconnected"

**สาเหตุที่อาจเป็น:**
- 📡 ESP32 publish ทะเบียนรับไม่มา
- ⏱️ Telemetry ล่าสุดอายุ > 15 วิ

**วิธีแก้:**
1. ตรวจสอบ MQTT Connection
2. ดูใน Serial Monitor
3. ตรวจสอบ MQTT Topics ใน broker หรือ https://www.hivemq.com/web-client/

### ❌ PIR Sensor ไม่ทำงาน

**สาเหตุที่อาจเป็น:**
- 🔌 ต่อสาย GPIO 13 ผิด
- ⚡ ไม่ได้กำลังจ่ายเต็มที่
- 🔥 ตัวรับสัญญาณหมดอายุ

**วิธีแก้:**
1. ตรวจสอบการต่อสาย (GPIO 13, 5V, GND)
2. ดูค่า PIR ใน Serial Monitor
3. ตรวจสอบด้วย LED สถานะ

### ❌ LDR Sensor ค่าผิดปกติ

**สาเหตุที่อาจเป็น:**
- 💡 แสงรอบข้างเปลี่ยนแปลง
- ⚡ Voltage divider ถูกต่องผิด
- 🪛 Resistor ค่าผิด

**วิธีแก้:**
1. ใช้ flashlight ทดสอบค่า LDR
2. ตรวจสอบค่า:
   - Dark room: 200-500
   - Normal office: 1000-1500
   - Bright sunlight: 3000-4095
3. ปรับ Resistor 10kΩ

### ❌ Relay ไม่ทำงาน

**สาเหตุที่อาจเป็น:**
- 🔌 ต่อ GPIO 26 ผิด
- ⚡ ไม่ได้กำลังจ่ายเต็มที่
- 🔀 Polarity เลือกผิด (RELAY_ACTIVE_LOW)

**วิธีแก้:**
1. ตรวจสอบ GPIO 26 connected ถึง Relay IN
2. ทดสอบด้วยคำสั่ง: `RELAY:ON` / `RELAY:OFF`
3. หากกลับด้าน:
   ```cpp
   #define RELAY_ACTIVE_LOW  1  // ลองสลับ
   ```

### ❌ LCD ไม่แสดงข้อมูล

**สาเหตุที่อาจเป็น:**
- 🔌 SDA/SCL ต่อผิด GPIO 21/22
- 📍 I2C Address ผิด (ควรเป็น 0x27)
- ⚡ Pull-up ขาด

**วิธีแก้:**
1. ตรวจสอบ I2C connection:
   ```cpp
   Wire.begin(21, 22);  // SDA, SCL
   ```
2. ทดสอบ Address:
   ```bash
   i2cdetect -y 1  # Linux/Mac
   # หรือใช้ I2C Scanner sketch
   ```
3. เพิ่ม Pull-up Resistors (4.7kΩ)

### ❌ Node.js Server ไม่ start

**สาเหตุที่อาจเป็น:**
- 🔌 Port 3000 ถูกใช้อยู่
- 📦 Dependencies ขาด
- 🔐 Permission ปฏิเสธ

**วิธีแก้:**
1. ติดตั้ง dependencies ใหม่:
   ```bash
   npm install
   ```
2. เลือก port อื่น:
   ```bash
   PORT=3001 npm start
   ```
3. ตรวจสอบ process ที่ใช้ port 3000:
   ```bash
   lsof -i :3000  # macOS/Linux
   netstat -ano | findstr :3000  # Windows
   ```

### ❌ Web Dashboard ไม่โหลด

**สาเหตุที่อาจเป็น:**
- 🔌 Server ไม่ running
- 🌐 URL ผิด
- 🔄 CORS Error

**วิธีแก้:**
1. ตรวจสอบ Server running:
   ```bash
   curl http://localhost:3000  # ควรได้ HTML
   ```
2. เช็ก Console Errors (F12 → Console)
3. Reload: Ctrl+Shift+R (hard refresh)

### ❌ ไม่ได้รับการแจ้งเตือน Telegram

**สาเหตุที่อาจเป็น:**
- 🔐 Bot Token ผิด
- 💬 Chat ID ผิด
- 📡 MQTT ไม่เชื่อมต่อ

**วิธีแก้:**
1. ตรวจสอบ Bot Token:
   - Chat @BotFather
   - ส่ง `/mybots` → เลือก bot → ดูข้อมูล
2. ตรวจสอบ Chat ID:
   - Chat @RawDataBot
   - ดู `message.chat.id`
3. Update SmartDesktop.ino และ Upload

---

## 📚 คำศัพท์เทคนิค

| ศัพท์ | ความหมาย |
|------|---------|
| **PIR** | Passive Infrared Sensor - เซนเซอร์ตรวจจับการเคลื่อนไหว |
| **LDR** | Light Dependent Resistor - เซนเซอร์ตรวจจับความสว่าง |
| **Relay** | อุปกรณ์สวิตช์ไฟฟ้า - ใช้สยวิทช์ On/Off |
| **MQTT** | Message Queuing Telemetry Transport - โปรโตคอลการสื่อสาร |
| **Broker** | เซิร์ฟเวอร์กลางรับ/ส่ง MQTT Messages |
| **Topic** | ช่องทาง MQTT สำหรับส่ง Topic |
| **Telemetry** | ข้อมูลที่ส่งมาจากอุปกรณ์ |
| **Session** | ช่วงเวลาการนั่งหนึ่งครั้ง |
| **I2C** | Inter-Integrated Circuit - โปรโตคอลการสื่อสาร 2-wire |
| **GPIO** | General Purpose Input/Output - ขา input/output ทั่วไป |
| **ADC** | Analog-to-Digital Converter - แปลง analog → digital |
| **RSSI** | Received Signal Strength Indicator - ความแข็งแรงของสัญญาณ |
| **Cooldown** | ช่วงเวลาที่ต้องรอก่อนเคลื่อนการกระทำอีกครั้ง |
| **Payload** | ข้อมูลที่ส่งใน MQTT Message |
| **Polling** | การถามข้อมูลซ้ำๆ ในช่วงเวลาที่กำหนด |

---

## 📞 ติดต่อและสนับสนุน

- 🐛 **ปัญหาหรือข้อเสนอแนะ**: สร้าง Issue บน GitHub
- 📧 **อีเมล**: (ตามที่ระบุไว้ใน README.md)
- 🌐 **Wokwi Simulation**: https://wokwi.com/projects/456402689542281217

---

**เวอร์ชั่น**: 1.0.0  
**อัปเดตล่าสุด**: February 24, 2026  
**ภาษา**: ไทย (Thai)
