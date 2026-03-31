#include <WiFi.h>
#include <PubSubClient.h>
#include <ESP32Servo.h>
#include <ArduinoJson.h>
#include "secrets.h"

namespace {
constexpr unsigned long MEASURE_INTERVAL_MS = 2000;
constexpr unsigned long MQTT_RETRY_MS = 5000;
constexpr unsigned long EDGE_OVERRIDE_TIMEOUT_MS = 15000;
constexpr float FLOOD_THRESHOLD_CM = 20.0f;
constexpr float HYSTERESIS_CM = 4.0f;

constexpr uint8_t TRIG_PIN = 5;
constexpr uint8_t ECHO_PIN = 18;
constexpr uint8_t SERVO_PIN = 19;
constexpr uint8_t LED_OK = 2;
constexpr uint8_t LED_ALERT = 4;

const char* DEVICE_ID = "ESP32_AquaDivert_01";
const char* MQTT_TOPIC_PUB = "aquasensor/data";
const char* MQTT_TOPIC_CMD = "aquasensor/command";
constexpr float GPS_LAT = -29.8587f;
constexpr float GPS_LON = 31.0218f;
}

WiFiClient wifiClient;
PubSubClient mqttClient(wifiClient);
Servo gateServo;

float waterLevelCm = 400.0f;
float batteryLevel = 95.0f;
float blockageIndex = 0.0f;
bool gateDeployed = false;
bool edgeOverride = false;
unsigned long lastMeasureAt = 0;
unsigned long lastEdgeCommandAt = 0;

float clampFloat(float value, float minimum, float maximum) {
  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

void onMessage(char* topic, byte* payload, unsigned int length) {
  String message;
  for (unsigned int index = 0; index < length; index++) {
    message += (char)payload[index];
  }

  StaticJsonDocument<128> doc;
  if (deserializeJson(doc, message) != DeserializationError::Ok) {
    return;
  }

  if (String(topic) == MQTT_TOPIC_CMD && doc["command"] == "valve") {
    const bool openValve = doc["open"] | false;
    edgeOverride = true;
    lastEdgeCommandAt = millis();

    if (openValve && !gateDeployed) {
      gateServo.write(90);
      gateDeployed = true;
      Serial.println("[CMD] Edge -> GATE OPEN");
    } else if (!openValve && gateDeployed) {
      gateServo.write(0);
      gateDeployed = false;
      Serial.println("[CMD] Edge -> GATE CLOSED");
    }
  }
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting to Wi-Fi");
  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 40) {
    delay(500);
    Serial.print('.');
    retries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("\nWi-Fi connected: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWi-Fi connection failed. Restarting...");
    ESP.restart();
  }
}

void reconnectMQTT() {
  while (!mqttClient.connected()) {
    connectWiFi();
    Serial.print("MQTT reconnect...");

    if (mqttClient.connect(MQTT_CLIENT_ID, MQTT_USERNAME, MQTT_PASSWORD)) {
      mqttClient.subscribe(MQTT_TOPIC_CMD);
      Serial.println(" connected");
      return;
    }

    Serial.printf(" failed rc=%d\n", mqttClient.state());
    delay(MQTT_RETRY_MS);
  }
}

void readWaterLevel() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 50000);
  waterLevelCm = duration == 0 ? 400.0f : duration * 0.034f / 2.0f;
  if (waterLevelCm > 400.0f || waterLevelCm < 2.0f) {
    waterLevelCm = 400.0f;
  }
}

bool isEdgeOverrideActive() {
  if (edgeOverride && (millis() - lastEdgeCommandAt) >= EDGE_OVERRIDE_TIMEOUT_MS) {
    edgeOverride = false;
  }
  return edgeOverride;
}

void localFloodControl() {
  if (isEdgeOverrideActive()) {
    return;
  }

  const bool floodDetected = waterLevelCm < FLOOD_THRESHOLD_CM;
  if (floodDetected && !gateDeployed) {
    gateServo.write(90);
    gateDeployed = true;
    Serial.println("[LOCAL] Flood detected -> gate open");
  } else if (!floodDetected && gateDeployed && waterLevelCm > (FLOOD_THRESHOLD_CM + HYSTERESIS_CM)) {
    gateServo.write(0);
    gateDeployed = false;
    Serial.println("[LOCAL] Water receded -> gate closed");
  }
}

void publishData() {
  if (!mqttClient.connected()) {
    return;
  }

  blockageIndex = clampFloat((FLOOD_THRESHOLD_CM + HYSTERESIS_CM - waterLevelCm) / (FLOOD_THRESHOLD_CM + HYSTERESIS_CM), 0.0f, 1.0f);

  StaticJsonDocument<256> doc;
  doc["deviceID"] = DEVICE_ID;
  doc["batteryLevel"] = roundf(batteryLevel * 10.0f) / 10.0f;
  doc["gpsLat"] = GPS_LAT;
  doc["gpsLon"] = GPS_LON;
  doc["waterLevel_cm"] = roundf(waterLevelCm * 10.0f) / 10.0f;
  doc["blockageIndex"] = roundf(blockageIndex * 100.0f) / 100.0f;
  doc["gatePosition"] = gateDeployed ? 90 : 0;
  doc["timestamp"] = millis() / 1000;

  String payload;
  serializeJson(doc, payload);
  mqttClient.publish(MQTT_TOPIC_PUB, payload.c_str(), false);
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("AquaDivert ESP32 live sensor mode");

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  pinMode(LED_OK, OUTPUT);
  pinMode(LED_ALERT, OUTPUT);
  digitalWrite(LED_OK, HIGH);
  digitalWrite(LED_ALERT, LOW);

  gateServo.attach(SERVO_PIN);
  gateServo.write(0);

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setCallback(onMessage);

  connectWiFi();
  reconnectMQTT();
}

void loop() {
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }

  mqttClient.loop();

  if (millis() - lastMeasureAt >= MEASURE_INTERVAL_MS) {
    lastMeasureAt = millis();
    readWaterLevel();
    localFloodControl();

    const bool alert = waterLevelCm < FLOOD_THRESHOLD_CM;
    digitalWrite(LED_ALERT, alert ? HIGH : LOW);
    digitalWrite(LED_OK, alert ? LOW : HIGH);

    publishData();

    batteryLevel -= 0.01f;
    if (batteryLevel < 5.0f) {
      batteryLevel = 100.0f;
    }

    Serial.printf("Water distance: %.1f cm | Gate: %s | Battery: %.0f%%\n",
                  waterLevelCm,
                  gateDeployed ? "OPEN" : "CLOSED",
                  batteryLevel);
  }
}
