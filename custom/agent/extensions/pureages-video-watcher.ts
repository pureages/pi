import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

interface VideoInfo {
  duration: number;
  width: number;
  height: number;
}

interface WatchVideoParams {
  path: string;
  maxFrames?: number;
  maxEdge?: number;
  start?: number;
  end?: number;
}

/** 用 ffprobe 获取视频时长与分辨率 */
async function probeVideo(filePath: string): Promise<VideoInfo> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,duration:format=duration",
      "-of", "json",
      filePath,
    ],
    { timeout: 15_000 },
  );
  const data = JSON.parse(stdout);
  const stream = data.streams?.[0] ?? {};
  const duration = parseFloat(stream.duration ?? data.format?.duration ?? "0");
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: Number(stream.width) || 0,
    height: Number(stream.height) || 0,
  };
}

/** 等比缩放到最长边 maxEdge，返回 "W:H" 或 null（原尺寸） */
function computeScale(width: number, height: number, maxEdge: number): string | null {
  if (!width || !height) return null;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(2, Math.round((width * scale) / 2) * 2); // 保持偶数
  const h = Math.max(2, Math.round((height * scale) / 2) * 2);
  return `${w}:${h}`;
}

/** 抽取单个时间点的帧为 jpg */
async function extractFrame(
  filePath: string,
  time: number,
  scale: string | null,
  outJpg: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const args = ["-y", "-ss", String(time), "-i", filePath, "-frames:v", "1"];
  if (scale) args.push("-vf", `scale=${scale}`);
  args.push("-q:v", "3", outJpg);
  await execFileAsync("ffmpeg", args, { timeout: 60_000, signal });
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `[pureages_watch_video] 错误: ${message}` }],
    details: { isError: true },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "pureages_watch_video",
    label: "Watch Video (frames)",
    description:
      "查看本地视频内容：用 ffmpeg 按时间点抽取若干帧并以图片序列返回，模型据此理解视频画面。" +
      "抽帧规则：默认每 6 秒 1 帧（短视频保底 6 帧），受 maxFrames 上限约束。" +
      "必填 path；可选 maxFrames（最大帧数，默认 30）、maxEdge（帧最长边像素，默认 768，控制 token 用量）、" +
      "start/end（只看某段时间，单位秒）。支持 mp4/mov/webm/mkv 等常见格式，需系统已安装 ffmpeg。",
    promptSnippet: "抽取视频帧以图片形式查看视频内容",
    promptGuidelines: [
      "Use pureages_watch_video when the user wants you to look at the content of a local video file; the tool returns sampled frames as images.",
      "When the user gives a time range, pass start/end (seconds). For long videos prefer more frames with a smaller maxEdge to stay within context.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "本地视频文件路径（mp4/mov/webm/mkv 等）" }),
      maxFrames: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 60,
          default: 30,
          description: "最大帧数上限，默认 30（抽帧规则为每 6 秒 1 帧，短视频保底 6 帧）",
        }),
      ),
      maxEdge: Type.Optional(
        Type.Integer({
          minimum: 320,
          maximum: 1280,
          default: 768,
          description: "帧的最长边像素（等比缩放），默认 768",
        }),
      ),
      start: Type.Optional(Type.Number({ description: "起始时间（秒），默认 0" })),
      end: Type.Optional(Type.Number({ description: "结束时间（秒），默认视频结尾" })),
    }),

    async execute(
      toolCallId: string,
      params: WatchVideoParams,
      signal: AbortSignal | undefined,
      onUpdate?: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ) {
      const absPath = path.resolve(params.path);

      // 1. 文件检查
      try {
        const st = await fs.stat(absPath);
        if (!st.isFile()) return errorResult(`路径不是文件: ${absPath}`);
      } catch {
        return errorResult(`找不到文件: ${absPath}`);
      }

      // 2. 视频信息
      let info: VideoInfo;
      try {
        info = await probeVideo(absPath);
      } catch (e) {
        return errorResult(`ffprobe 解析失败（${(e as Error).message}），请确认是有效视频且 ffmpeg 已安装`);
      }
      if (!info.duration || info.duration <= 0) {
        return errorResult(`无法获取视频时长: ${absPath}`);
      }

      // 3. 时间点：默认每 6 秒抽 1 帧；短视频保底 6 帧；总帧数受 maxFrames 上限约束
      const start = Math.max(0, params.start ?? 0);
      const end = Math.min(info.duration, params.end ?? info.duration);
      if (end <= start) return errorResult(`时间段无效（start=${start} end=${end}）`);
      const secondsPerFrame = 6;
      const minFrames = 6;
      const wantFrames = Math.max(minFrames, params.maxFrames ?? 30);
      const n = Math.min(wantFrames, Math.max(minFrames, Math.ceil((end - start) / secondsPerFrame)));
      const times = Array.from({ length: n }, (_, i) => start + ((i + 0.5) * (end - start)) / n);

      // 4. 抽帧
      const scale = computeScale(info.width, info.height, params.maxEdge ?? 768);
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pureages-vid-"));
      const contents: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        {
          type: "text",
          text:
            `视频 ${path.basename(absPath)}：时长 ${info.duration.toFixed(1)}s，` +
            `${info.width}x${info.height}${scale ? `，抽帧缩放至 ${scale}` : ""}，` +
            `共抽 ${n} 帧（${start.toFixed(1)}s ~ ${end.toFixed(1)}s），帧对应时间点: ${times
              .map((t) => t.toFixed(1))
              .join(", ")}s`,
        },
      ];

      for (let i = 0; i < n; i++) {
        if (signal?.aborted) break;
        onUpdate?.({ content: [{ type: "text", text: `正在抽帧 ${i + 1}/${n}...` }] });
        const jpg = path.join(tmpDir, `frame_${i}.jpg`);
        try {
          await extractFrame(absPath, times[i], scale, jpg, signal);
          const buf = await fs.readFile(jpg);
          contents.push({ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" });
        } catch (e) {
          contents.push({
            type: "text",
            text: `帧 ${i + 1}（@${times[i].toFixed(1)}s）抽取失败: ${(e as Error).message}`,
          });
        }
      }

      // 清理临时目录
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

      return {
        content: contents,
        details: {
          video: absPath,
          duration: info.duration,
          width: info.width,
          height: info.height,
          frames: n,
          times,
        },
      };
    },
  });
}
