package com.kkk.bd2viewer.jczx;

import net.jpountz.lz4.LZ4Factory;
import net.jpountz.lz4.LZ4SafeDecompressor;

import org.tukaani.xz.LZMAInputStream;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * MIT UnityFS reader subset for JCZX spine AssetBundles.
 * Handles: fake dual-UnityFS strip, blocksInfo (LZMA/LZ4/none), data blocks, directory nodes.
 */
public final class UnityFs {
    public static final byte[] MAGIC = new byte[]{'U', 'n', 'i', 't', 'y', 'F', 'S', 0};

    private UnityFs() {}

    public static List<Integer> findUnityFsOffsets(byte[] buf) {
        List<Integer> offs = new ArrayList<>();
        int start = 0;
        while (start + MAGIC.length <= buf.length) {
            int i = indexOf(buf, MAGIC, start);
            if (i < 0) break;
            offs.add(i);
            start = i + 1;
        }
        return offs;
    }

    /** Keep from the second UnityFS magic (JCZX dual-header); else first non-zero, else whole buffer. */
    public static byte[] stripToSecondUnityFs(byte[] buf) {
        List<Integer> offs = findUnityFsOffsets(buf);
        if (offs.size() >= 2) {
            int from = offs.get(1);
            byte[] out = new byte[buf.length - from];
            System.arraycopy(buf, from, out, 0, out.length);
            return out;
        }
        if (offs.size() == 1 && offs.get(0) > 0) {
            int from = offs.get(0);
            byte[] out = new byte[buf.length - from];
            System.arraycopy(buf, from, out, 0, out.length);
            return out;
        }
        return buf;
    }

    public static boolean looksLikeUnityFs(byte[] head) {
        if (head == null || head.length < MAGIC.length) return false;
        for (int i = 0; i < MAGIC.length; i++) if (head[i] != MAGIC[i]) return false;
        return true;
    }

    /**
     * Decompress UnityFS into concatenated block stream, then split by directory nodes.
     * Keys are node paths (e.g. CAB-… / CAB-….resS).
     */
    public static Map<String, byte[]> readNodes(byte[] unityFs) throws IOException {
        if (!looksLikeUnityFs(unityFs)) throw new IOException("not UnityFS");
        ByteBuffer r = ByteBuffer.wrap(unityFs).order(ByteOrder.BIG_ENDIAN);
        r.position(MAGIC.length);
        int version = r.getInt();
        String player = readCString(r);
        String engine = readCString(r);
        long size = r.getLong();
        int compressedBlocksInfoSize = r.getInt();
        int uncompressedBlocksInfoSize = r.getInt();
        int flags = r.getInt();
        if (version >= 7) {
            int pad = (16 - (r.position() % 16)) % 16;
            r.position(r.position() + pad);
        }
        // ArchiveFlags: BlocksInfoAtTheEnd = 0x80
        byte[] blocksInfoCompressed;
        if ((flags & 0x80) != 0) {
            int save = r.position();
            r.position(unityFs.length - compressedBlocksInfoSize);
            blocksInfoCompressed = new byte[compressedBlocksInfoSize];
            r.get(blocksInfoCompressed);
            r.position(save);
        } else {
            blocksInfoCompressed = new byte[compressedBlocksInfoSize];
            r.get(blocksInfoCompressed);
        }
        byte[] blocksInfo = decompress(blocksInfoCompressed, uncompressedBlocksInfoSize, flags & 0x3F);

        ByteBuffer bi = ByteBuffer.wrap(blocksInfo).order(ByteOrder.BIG_ENDIAN);
        bi.position(16); // uncompressedDataHash
        int blockCount = bi.getInt();
        int[] uSizes = new int[blockCount];
        int[] cSizes = new int[blockCount];
        int[] bFlags = new int[blockCount];
        for (int i = 0; i < blockCount; i++) {
            uSizes[i] = bi.getInt();
            cSizes[i] = bi.getInt();
            bFlags[i] = bi.getShort() & 0xFFFF;
        }
        int nodeCount = bi.getInt();
        long[] nOff = new long[nodeCount];
        long[] nSize = new long[nodeCount];
        String[] nPath = new String[nodeCount];
        for (int i = 0; i < nodeCount; i++) {
            nOff[i] = bi.getLong();
            nSize[i] = bi.getLong();
            bi.getInt(); // flags
            nPath[i] = readCString(bi);
        }

        // BlockInfoNeedPaddingAtStart = 0x200 (new ArchiveFlags)
        if ((flags & 0x200) != 0) {
            int pad = (16 - (r.position() % 16)) % 16;
            r.position(r.position() + pad);
        }

        ByteArrayOutputStream data = new ByteArrayOutputStream(Math.max(16, sum(uSizes)));
        for (int i = 0; i < blockCount; i++) {
            byte[] chunk = new byte[cSizes[i]];
            r.get(chunk);
            byte[] part = decompress(chunk, uSizes[i], bFlags[i] & 0x3F);
            data.write(part);
        }
        byte[] all = data.toByteArray();
        Map<String, byte[]> nodes = new LinkedHashMap<>();
        for (int i = 0; i < nodeCount; i++) {
            int from = (int) nOff[i];
            int len = (int) nSize[i];
            if (from < 0 || len < 0 || (long) from + len > all.length) {
                throw new IOException("node out of range: " + nPath[i]);
            }
            byte[] slice = new byte[len];
            System.arraycopy(all, from, slice, 0, len);
            nodes.put(nPath[i], slice);
        }
        // silence unused
        if (player == null || engine == null || size == 0) { /* keep fields for debug */ }
        return nodes;
    }

    private static int sum(int[] a) {
        long s = 0;
        for (int v : a) s += v;
        return s > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) s;
    }

    /** CompressionFlags: 0 none, 1 LZMA, 2/3 LZ4/LZ4HC */
    static byte[] decompress(byte[] src, int uncompressedSize, int compression) throws IOException {
        if (compression == 0) return src;
        if (compression == 1) return decompressLzma(src, uncompressedSize);
        if (compression == 2 || compression == 3) return decompressLz4(src, uncompressedSize);
        throw new IOException("unsupported UnityFS compression: " + compression);
    }

    /** Unity raw LZMA1: 1 byte props + 4 byte LE dictSize + payload (no streamed size). */
    static byte[] decompressLzma(byte[] src, int uncompressedSize) throws IOException {
        if (src.length < 5) throw new IOException("lzma too short");
        byte props = src[0];
        int dictSize = (src[1] & 0xff)
                | ((src[2] & 0xff) << 8)
                | ((src[3] & 0xff) << 16)
                | ((src[4] & 0xff) << 24);
        // Unity LZMA streams: tukaani rejects "known size" for these RAW payloads;
        // always decompress with uncompSize=-1 (EOS), then verify length.
        try (LZMAInputStream in = new LZMAInputStream(
                new ByteArrayInputStream(src, 5, src.length - 5),
                -1L,
                props,
                dictSize)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream(
                    uncompressedSize > 0 ? uncompressedSize : 65536);
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) >= 0) bos.write(buf, 0, n);
            byte[] out = bos.toByteArray();
            if (uncompressedSize > 0 && out.length != uncompressedSize) {
                throw new IOException("lzma size mismatch " + out.length + "/" + uncompressedSize);
            }
            return out;
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException("lzma: " + e.getMessage(), e);
        }
    }

    static byte[] decompressLz4(byte[] src, int uncompressedSize) throws IOException {
        if (uncompressedSize <= 0) throw new IOException("lz4 needs uncompressed size");
        try {
            LZ4SafeDecompressor dec = LZ4Factory.safeInstance().safeDecompressor();
            byte[] out = new byte[uncompressedSize];
            int n = dec.decompress(src, 0, src.length, out, 0, uncompressedSize);
            if (n != uncompressedSize) throw new IOException("lz4 size mismatch");
            return out;
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException("lz4: " + e.getMessage(), e);
        }
    }

    private static String readCString(ByteBuffer r) {
        int start = r.position();
        while (r.hasRemaining() && r.get() != 0) { /* advance */ }
        int end = r.position() - 1;
        byte[] b = new byte[Math.max(0, end - start)];
        for (int i = 0; i < b.length; i++) b[i] = r.get(start + i);
        return new String(b, StandardCharsets.UTF_8);
    }

    private static int indexOf(byte[] hay, byte[] needle, int from) {
        outer:
        for (int i = from; i <= hay.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) continue outer;
            }
            return i;
        }
        return -1;
    }
}
