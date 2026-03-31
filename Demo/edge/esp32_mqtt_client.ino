#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include "secrets.h"

namespace {
constexpr uint16_t MQTT_PORT = 8883;
constexpr unsigned long PUBLISH_INTERVAL_MS = 5000;
constexpr unsigned long INITIAL_BACKOFF_MS = 1000;
constexpr unsigned long MAX_BACKOFF_MS = 30000;
const char* NODE_ID = "S-14";
const char* CITY = "smart-city";
}

WiFiClientSecure secureClient;
PubSubClient mqttClient(secureClient);
unsigned long lastPublishAt = 0;
unsigned long reconnectDelayMs = INITIAL_BACKOFF_MS;

String baseTopic() {
  return String("city/drainage/") + NODE_ID;
}

String statusTopic() {
  return baseTopic() + "/status";
}

String telemetryTopic() {
  return baseTopic() + "/telemetry/water-level";
}

String alertTopic() {
  return baseTopic() + "/alerts/edge-ai";
}

String isoTimestamp() {
  return String((uint32_t)(millis() / 1000));
}

String onlineStatusPayload(const char* reason) {
  return String("{\"schema_version\":\"1.0.0\",\"node_id\":\"") + NODE_ID +
         "\",\"timestamp\":\"" + isoTimestamp() +
         "\",\"status\":\"online\",\"reason\":\"" + reason + "\"}";
}

String offlineStatusPayload() {
  return String("{\"schema_version\":\"1.0.0\",\"node_id\":\"") + NODE_ID +
         "\",\"timestamp\":\"" + isoTimestamp() +
         "\",\"status\":\"offline\",\"reason\":\"LWT unexpected disconnect\"}";
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print('.');
  }

  Serial.println("\nWi-Fi connected");
}

bool connectMqttWithBackoff() {
  while (!mqttClient.connected()) {
    connectWiFi();

    Serial.printf("Connecting to MQTT over TLS in %lu ms...\n", reconnectDelayMs);
    delay(reconnectDelayMs);

    if (mqttClient.connect(
            MQTT_CLIENT_ID,
            MQTT_USERNAME,
            MQTT_PASSWORD,
            statusTopic().c_str(),
            1,
            true,
            offlineStatusPayload().c_str())) {
      reconnectDelayMs = INITIAL_BACKOFF_MS;
      mqttClient.publish(statusTopic().c_str(), onlineStatusPayload("boot-complete").c_str(), true);
      Serial.println("MQTT connected");
      return true;
    }

    Serial.printf("MQTT connect failed, rc=%d\n", mqttClient.state());
    reconnectDelayMs = min(reconnectDelayMs * 2, MAX_BACKOFF_MS);
  }

  return true;
}

void publishDummyTelemetry() {
  float phase = millis() / 10000.0f;
  float waterPct = 45.0f + sinf(phase) * 22.0f;
  int waterMm = (int)(waterPct * 11.2f);
  bool blockageDetected = waterPct > 72.0f;

  char telemetryPayload[256];
  snprintf(
      telemetryPayload,
      sizeof(telemetryPayload),
      "{\"schema_version\":\"1.0.0\",\"city\":\"%s\",\"node_id\":\"%s\",\"timestamp\":\"%s\",\"water_level_mm\":%d,\"water_level_pct\":%.1f,\"flow_rate_lps\":%.1f,\"battery_pct\":95.0,\"signal_rssi_dbm\":-54}",
      CITY,
      NODE_ID,
      isoTimestamp().c_str(),
      waterMm,
      waterPct,
      76.0f - (waterPct * 0.3f));

  mqttClient.publish(telemetryTopic().c_str(), telemetryPayload, false);

  if (blockageDetected) {
    char alertPayload[256];
    snprintf(
        alertPayload,
        sizeof(alertPayload),
        "{\"schema_version\":\"1.0.0\",\"city\":\"%s\",\"node_id\":\"%s\",\"timestamp\":\"%s\",\"blockage_detected\":true,\"severity\":\"high\",\"waste_classification\":[{\"label\":\"plastic\",\"confidence\":0.93,\"count\":2}],\"notes\":\"POPIA-safe metadata only\"}",
        CITY,
        NODE_ID,
        isoTimestamp().c_str());

    mqttClient.publish(alertTopic().c_str(), alertPayload, false);
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  secureClient.setCACert(ROOT_CA);
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);

  connectWiFi();
  connectMqttWithBackoff();
}

void loop() {
  if (!mqttClient.connected()) {
    connectMqttWithBackoff();
  }

  mqttClient.loop();

  if (millis() - lastPublishAt >= PUBLISH_INTERVAL_MS) {
    lastPublishAt = millis();
    publishDummyTelemetry();
  }
}
