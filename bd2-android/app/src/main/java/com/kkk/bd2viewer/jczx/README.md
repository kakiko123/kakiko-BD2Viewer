# Android JCZX extract (Phase 1)

Pure Java UnityFS strip + decompress + Spine atlas/json/png export.
No Python / Chaquopy / GPL AssetTool on device.

## Unit test (JDK 17+, Maven jars)

```bash
# download org.tukaani:xz:1.9, org.lz4:lz4-java:1.8.0, org.json:json
javac -cp xz.jar:lz4-java.jar:json.jar -d out $(find . -name '*.java')
java -Xmx1g -cp out:xz.jar:lz4-java.jar:json.jar \
  com.kkk.bd2viewer.jczx.JczxExtractor /path/to/prefabs_spine_* /tmp/out
```

Wired from `ScanEngine` when `mode=jczx`: scans `BD2Viewer/jczx/`, extracts into `bd2viewer-jczx/`.

## Texture locate (RGBA32)

Do **not** take the last `w*h*4` length-prefix alone (false positives in Spine JSON).
Match Unity Texture2D: `m_Width|m_Height|m_CompleteImageSize` then the following image-data length prefix.
`EXTRACT_ENGINE` bump invalidates on-device cache after heuristic changes.
phase1.2 also re-extracts when stamp matches but outputs are wrong (tiny PNG vs atlas WxH, or missing `.json`).
