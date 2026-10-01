package com.kkk.bd2viewer.jczx;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

/**
 * Minimal RGBA8 → PNG writer (no Android / ImageIO dependency).
 * MIT — written for BD2Viewer JCZX on-device extract.
 */
public final class PngEncoder {
    private PngEncoder() {}

    public static void writeRGBA(OutputStream out, byte[] rgba, int width, int height) throws IOException {
        if (rgba == null || width <= 0 || height <= 0) throw new IOException("bad image");
        long need = (long) width * height * 4L;
        if (rgba.length < need) throw new IOException("rgba too short: " + rgba.length + " < " + need);

        out.write(new byte[]{(byte) 137, 80, 78, 71, 13, 10, 26, 10});

        ByteBuffer ihdr = ByteBuffer.allocate(13).order(ByteOrder.BIG_ENDIAN);
        ihdr.putInt(width);
        ihdr.putInt(height);
        ihdr.put((byte) 8);  // bit depth
        ihdr.put((byte) 6);  // RGBA
        ihdr.put((byte) 0);
        ihdr.put((byte) 0);
        ihdr.put((byte) 0);
        writeChunk(out, "IHDR", ihdr.array());

        // raw scanlines with filter byte 0
        byte[] raw = new byte[(width * 4 + 1) * height];
        int src = 0;
        int dst = 0;
        int rowBytes = width * 4;
        for (int y = 0; y < height; y++) {
            raw[dst++] = 0;
            System.arraycopy(rgba, src, raw, dst, rowBytes);
            src += rowBytes;
            dst += rowBytes;
        }

        Deflater def = new Deflater(Deflater.DEFAULT_COMPRESSION);
        def.setInput(raw);
        def.finish();
        ByteArrayOutputStream z = new ByteArrayOutputStream(raw.length / 2 + 64);
        byte[] buf = new byte[65536];
        while (!def.finished()) {
            int n = def.deflate(buf);
            if (n > 0) z.write(buf, 0, n);
        }
        def.end();
        writeChunk(out, "IDAT", z.toByteArray());
        writeChunk(out, "IEND", new byte[0]);
    }

    private static void writeChunk(OutputStream out, String type, byte[] data) throws IOException {
        ByteBuffer len = ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN);
        len.putInt(data.length);
        out.write(len.array());
        byte[] typeBytes = type.getBytes("US-ASCII");
        out.write(typeBytes);
        out.write(data);
        CRC32 crc = new CRC32();
        crc.update(typeBytes);
        crc.update(data);
        ByteBuffer c = ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN);
        c.putInt((int) crc.getValue());
        out.write(c.array());
    }
}
