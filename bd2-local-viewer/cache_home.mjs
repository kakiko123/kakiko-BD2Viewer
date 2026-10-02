/**
 * Shared helpers for spine path resolve + pack fingerprint dedupe.
 * Unpack caches (bd2viewer-jczx / bd2viewer-nikke) stay under the scan root
 * (e.g. BD2Viewer/jczx/bd2viewer-jczx is expected). Do not lift them to parent.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const MODE_SOURCE_FOLDERS = new Set(['bd2', 'nikke', 'lostsword', 'jczx'])

export function isInside(rootAbs, fileAbs) {
  const root = path.resolve(rootAbs)
  const file = path.resolve(fileAbs)
  const rel = path.relative(root, file)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function expandRelCandidates(relPath) {
  const raw = String(relPath || '').replace(/\\/g, '/')
  const out = new Set()
  const add = (s) => {
    let t = String(s || '').replace(/\\/g, '/')
    while (t.startsWith('/')) t = t.slice(1)
    while (t.includes('//')) t = t.replace(/\/\//g, '/')
    if (t.startsWith('./')) t = t.slice(2)
    if (t) out.add(t)
    try {
      if (/%[0-9a-fA-F]{2}/.test(t)) {
        const d = decodeURIComponent(t)
        if (d && d !== t) {
          let u = d.replace(/\\/g, '/')
          while (u.startsWith('/')) u = u.slice(1)
          if (u) out.add(u)
        }
      }
    } catch { /* */ }
  }
  add(raw)
  try { add(decodeURIComponent(raw)) } catch { /* */ }
  return [...out]
}

/**
 * Resolve /spine relative path against scan root (and optional cache dir leaf search).
 * Handles Chinese / space roots via percent-decode variants.
 */
export function resolveUnderRoot(scanRoot, relPath, { cacheDirNames = [] } = {}) {
  const base = path.resolve(scanRoot)
  const rels = expandRelCandidates(relPath)
  for (const rel of rels) {
    const abs = path.resolve(base, rel)
    if (isInside(base, abs) && fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs
  }
  const leaf = String(relPath || '').replace(/\\/g, '/').split('/').filter(Boolean).pop()
  if (leaf) {
    for (const cname of cacheDirNames) {
      const cacheRoot = path.join(base, cname)
      if (!fs.existsSync(cacheRoot)) continue
      try {
        for (const sub of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue
          const hit = path.join(cacheRoot, sub.name, leaf)
          if (fs.existsSync(hit) && fs.statSync(hit).isFile()) return hit
          try {
            for (const f of fs.readdirSync(path.join(cacheRoot, sub.name))) {
              if (f.toLowerCase() === leaf.toLowerCase()) {
                const p = path.join(cacheRoot, sub.name, f)
                if (fs.statSync(p).isFile()) return p
              }
            }
          } catch { /* */ }
        }
      } catch { /* */ }
    }
  }
  return null
}

/** Content fingerprint for pack dedupe: size + sha1(head+tail). */
export async function packFingerprint(absPath, size) {
  const crypto = await import('node:crypto')
  const fh = await fsp.open(absPath, 'r')
  try {
    const headLen = Math.min(65536, size)
    const head = Buffer.alloc(headLen)
    await fh.read(head, 0, headLen, 0)
    let tail = Buffer.alloc(0)
    if (size > 65536) {
      const tailLen = Math.min(4096, size - 65536)
      tail = Buffer.alloc(tailLen)
      await fh.read(tail, 0, tailLen, size - tailLen)
    }
    const h = crypto.createHash('sha1')
    h.update(head)
    h.update(tail)
    h.update(Buffer.from(String(size)))
    return `${size}:${h.digest('hex').slice(0, 16)}`
  } finally {
    await fh.close()
  }
}
