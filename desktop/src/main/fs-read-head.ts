// Main-process side of fs:read-head (see shared/read-head.ts for the contract
// and why it is not roots-gated). One function, called by BOTH the ipcMain
// handler and the remote-server WS case so the two cannot drift.
import fs from 'fs';
import path from 'path';
import { canonicalize } from '../shared/artifacts/canonicalize';
import { looksBinary } from '../shared/artifacts/editable-path-policy';
import { isSensitivePath } from './artifacts/read-binary-access';
import { clampHeadBytes, decodeHead, type ReadHeadResult } from '../shared/read-head';

export async function readFileHead(rawPath: unknown, maxBytes?: unknown): Promise<ReadHeadResult> {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || !path.isAbsolute(rawPath)) {
    return { ok: false, error: 'no path' };
  }
  // Same secret-location deny list as artifacts:read-binary, on the canonical
  // (symlink-resolved) path so a link into ~/.ssh is caught, not just the
  // literal spelling.
  let real = rawPath;
  try { real = await fs.promises.realpath(rawPath); } catch { /* decided below */ }
  if (isSensitivePath(canonicalize(real, null)) || isSensitivePath(canonicalize(rawPath, null))) {
    return { ok: false, error: 'not-allowed' };
  }
  const cap = clampHeadBytes(maxBytes);
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(real, 'r');
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, error: 'not-a-file' };
    // fs.read is only contractually required to return SOME bytes — loop until
    // the cap is full or the file ends. Never allocate more than the cap.
    const buf = Buffer.allocUnsafe(cap);
    let off = 0;
    while (off < cap) {
      const { bytesRead } = await fh.read(buf, off, cap - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    const head = buf.subarray(0, off);
    if (looksBinary(head)) return { ok: false, error: 'binary' };
    const truncated = st.size > off;
    return { ok: true, text: decodeHead(head, truncated), truncated };
  } catch (e: any) {
    return { ok: false, error: e?.code === 'ENOENT' ? 'orphan' : String(e?.message ?? e) };
  } finally {
    await fh?.close().catch(() => {});
  }
}
