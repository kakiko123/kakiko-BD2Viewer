package com.kkk.bd2viewer.jczx;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Shared constants for unpack/scan. Unpack caches stay under the mode scan root
 * (e.g. {@code BD2Viewer/jczx/bd2viewer-jczx}). Foreign thumb folders for other
 * games must not be created under another mode root — see ScanEngine.writeThumb.
 */
public final class UnpackCacheHome {
    private UnpackCacheHome() {}

    public static final Set<String> MODE_SOURCE_FOLDERS = new HashSet<>(Arrays.asList(
            "bd2", "nikke", "lostsword", "jczx"));
}
