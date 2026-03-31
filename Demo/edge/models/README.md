# Edge CV Model Notes

Place your **quantized TensorFlow Lite waste-detection model** here, for example:

- `waste_yolov5n_int8.tflite`

## Recommended model constraints

- **Format:** `.tflite`
- **Type:** quantized / INT8
- **Size:** **under 20 MB**
- **Target:** debris / waste / leaves / plastic / sediment classes

The runtime defaults to:

```text
./edge/models/waste_yolov5n_int8.tflite
```

If no model is present, or if the optional TensorFlow/TFLite packages are not installed, the Layer 2 runtime automatically falls back to a simple OpenCV heuristic mode so local testing can continue.
