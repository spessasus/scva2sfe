import { spawn } from "node:child_process";

/**
 * Encodes mono float audio to Ogg Vorbis with ffmpeg (libvorbis, quality 8), as syxg2sfe does.
 */
export function encodeVorbis(data: Float32Array, sampleRate: number) {
    return new Promise<Uint8Array>((resolve, reject) => {
        const ff = spawn(
            "ffmpeg",
            // bitexact: a fixed stream serial and no encoder tag, so two runs write the same bytes
            ["-v", "error", "-f", "f32le", "-ar", String(sampleRate), "-ac", "1", "-i", "pipe:0", "-c:a", "libvorbis", "-q:a", "8", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-f", "ogg", "pipe:1"],
            { stdio: ["pipe", "pipe", "inherit"] }
        );
        const chunks = new Array<Buffer>();
        ff.stdout.on("data", (c: Buffer) => chunks.push(c));
        ff.on("error", reject);
        ff.on("close", (code) => {
            if (code === 0) resolve(new Uint8Array(Buffer.concat(chunks)));
            else reject(new Error(`ffmpeg exited with ${code}`));
        });
        ff.stdin.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    });
}
