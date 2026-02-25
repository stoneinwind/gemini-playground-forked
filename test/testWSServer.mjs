import { createInterface } from 'readline';
import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import recorder from 'node-record-lpcm16'; // 用来在node中启动录音设备

// -- 处理参数
const WORKER_URL = "gemini-playground-forked.stoneinwind.deno.net"; // 你的 Worker 域名（不带 https://）

// 检查命令行参数
if (process.argv.length < 3) {
    console.log("📝 使用说明:");
    console.log("  node testWSServer.mjs <API_KEY> [voice]");
    console.log("");
    console.log("参数:");
    console.log("  API_KEY  (必需) - Google Gemini API 密钥");
    console.log("  voice    (可选) - 启用语音模式");
    console.log("");
    console.log("示例:");
    console.log("  node testWSServer.mjs AIzaSy...                 # 文本模式");
    console.log("  node testWSServer.mjs AIzaSy... voice         # 语音模式");
    process.exit(1);
}

const API_KEY = process.argv[2]; // 第一个自定义参数就是密钥
const IS_VOICE_MODE = process.argv[3] === 'voice'; // 检查是否有 voice 参数
const MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"; // 确保 Worker 支持此路径

// 1. 配置 readline 接口
const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '➤ 你: '
});

// -- 几个工具类方法
// 定义一个启动麦克风的函数
function startMic() {
    console.log("🎙️  正在通过 ffmpeg 初始化麦克风...");
    const micDevice = 'audio=麦克风 (Realtek(R) Audio)';  // 来自 ffmpeg -list_devices true -f dshow -i dummy里micronphone部分

    const recorder = spawn('ffmpeg', [
        '-f', 'dshow',
        '-i', micDevice,    // 曾尝试sox，失败，用ffmpeg
        '-ar', '16000',      // 采样率 16kHz - Gemini 接收 16kHz PCM 效果很好（但注意我们用ffplay播放回复依然是24000）
        '-ac', '1',          // 单声道
        '-f', 's16le',       // 原始 PCM 格式
        'pipe:1'             // 输出到标准输出
    ]);

    recorder.stdout.on('data', (data) => {
        if (socket.readyState === WebSocket.OPEN) {
            const b64Data = data.toString('base64');
            socket.send(JSON.stringify({
                realtime_input: {
                    media_chunks: [{
                        mime_type: "audio/pcm;rate=16000",
                        data: b64Data
                    }]
                }
            }));
        }
    });

    recorder.stderr.on('data', (data) => {
        // 这里的日志通常是 ffmpeg 的录音状态，调试时可以打开
        // console.log(`[Mic Debug] ${data}`);
    });

    recorder.on('error', (err) => {
        console.error("❌ 录音启动失败:", err);
    });
}

// 定义一个启动播放器的函数，方便重复调用
function startPlayer() {
    const p = spawn('ffplay', [
        '-nodisp',
        //'-autoexit',
        '-f', 's16le',    // 格式（ffplay -formats | grep s16le 确保有配置），注意：这格式只接受纯裸 PCM byte stream
        '-ar', '24000',   // 采样率
        //'-ac', '1',       // 声道（总是报错找不到，索性去掉，默认单声道播放）
        'pipe:0'         // 输入源设为标准输入（传统用“-”表示，但有可能有问题）
    ]);
    p.stderr.on('data', () => {}); // 忽略 ffplay 输出
    // --- 关键防御：拦截所有管道错误 ---
    p.stdin.on('error', (err) => {
        if (err.code === 'EPIPE' || err.code === 'EOF') {
            // 静默处理：这些是预料之中的打断错误
            return;
        }
        console.error("播放器管道意外错误:", err);
    });
    return p;
}

// 本地测试ffplay的方法
function testPlayer() {
    console.log("正在测试播放器... 你应该能听到 2 秒钟的鸣叫声");
    // 启动 ffplay 监听标准输入
    const player = spawn('ffplay', [
        '-nodisp',
        '-autoexit',
        '-f', 's16le',    // 格式（ffplay -formats | grep s16le 确保有配置），注意：这格式只接受纯裸 PCM byte stream
        '-ar', '24000',   // 采样率
        //'-ac', '1',       // 声道（总是报错找不到，索性去掉，默认单声道播放）
        '-i', 'pipe:0'         // 输入源设为标准输入（传统用“-”表示，但有可能有问题）
    ]);
    // 生成 24000Hz, 16-bit PCM 正弦波 (440Hz A4音)
    const sampleRate = 24000;
    const duration = 2; // 秒
    const frequency = 440;
    const numSamples = sampleRate * duration;
    const buffer = Buffer.alloc(numSamples * 2); // 每个采样 2 字节
    for (let i = 0; i < numSamples; i++) {
        const val = Math.sin(2 * Math.PI * frequency * (i / sampleRate)) * 10000;
        buffer.writeInt16LE(Math.floor(val), i * 2);
    }
    // 写入播放器
    player.stdin.write(buffer);
    player.stdin.end();
    player.on('close', (code) => {
        console.log(`播放器已关闭，代码: ${code}`);
    });
    player.stderr.on('data', (data) => {
        // ffplay 默认把日志输出到 stderr
        console.log(`FFplay Log: ${data}`);
    });
}

//testPlayer();

// 构造 WebSocket 地址
// 注意：Gemini WebSocket 路径通常需要包含 key 参数
const wsUrl = `wss://${WORKER_URL}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;
//const wsUrl = "wss://echo.websocket.org"; // 用来测试wss流式服务的网站（只负责原样回显）

console.log("正在连接到:", wsUrl);
const socket = new WebSocket(wsUrl);

// -- 监听连接建立
socket.onopen = () => {
  console.log(`✅ 已连接到 Worker 代理 (模式: ${IS_VOICE_MODE ? '语音' : '文本'})`);

  // 发送特定的SetUp消息 (Gemini 要求的特定格式)，这个必须发送，而且必须等待server端回复”成功“
  const setupMessage = {
    setup: {
      model: `models/${MODEL}`,
      generationConfig: {
            responseModalities: "audio", // ["AUDIO", "TEXT"],
            speechConfig: {
                languageCode: "en-US",
                voiceConfig: { 
                    prebuiltVoiceConfig: { 
                        voiceName: "Puck"    // You can change voice in the config.js file
                    }
                }
            },
        }
    }
  };
  socket.send(JSON.stringify(setupMessage));
  console.log("已发送 Setup 消息");
};

// 初始播放器实例
let currentPlayer = startPlayer();

// 一个支持流的本地文件（纯测试）
const audioFile = createWriteStream('gemini_out.raw'); 

// 监听服务器返回的消息
socket.onmessage = async (event) => {
    let rawData = event.data;

    // 1. 处理浏览器环境下的 Blob 对象
    if (rawData instanceof Blob) {
        // 将 Blob 转换为字符串
        rawData = await rawData.text(); 
    }

    try {
        const json = JSON.parse(rawData);
        // console.log("📩 收到 JSON 消息:", json);

        // 这条消息要特殊处理的，否则会hang住
        if (json.setupComplete) {
            console.log("🚀 模型就绪！现在你可以", IS_VOICE_MODE?"对着麦克风说话（无需特殊处理，GG会进行VAD判定是否发言结束":"输入任何话开始交谈（输入 'exit' 退出）");
            if (IS_VOICE_MODE) {
                startMic(); // 语音模式下开启麦克风
            } else {
                rl.prompt();
            }
            // const testMessage = {
            //     client_content: {
            //         turns: [
            //             {
            //                 role: "user",
            //                 parts: [{ text: "你好 Gemini！今天你的心情如何？" }]
            //             }
            //         ],
            //         turn_complete: true // 必须设为 true，否则模型会一直等待你输入
            //     }
            // };        
            // socket.send(JSON.stringify(testMessage));
        }

        // 2. 提取并解码音频数据
        // Gemini 的音频通常嵌套在 serverContent -> modelTurn -> parts 中
        const parts = json.serverContent?.modelTurn?.parts;
        if (parts) {
            for (const part of parts) {
                // 处理文本预览
                if (part.text) {
                    // 如果是文字回复，则打印并使用 \r 清除当前行，防止内容与 "➤ 你:" 重叠
                    process.stdout.write(`\r🤖: ${part.text}\n`);
                    rl.prompt(true); // 重新绘制提示符
                }                
                // 处理音频流
                if (part.inlineData && part.inlineData.data) {
                    //console.log("Audio inline MIME:", part.inlineData.mimeType); // Audio inline MIME: audio/pcm;rate=24000
                    const b64Data = part.inlineData.data;
                    const audioBuffer = Buffer.from(b64Data, 'base64');
                    // if (audioBuffer) {
                    //     audioFile.write(audioBuffer); // 直接存入文件（测试用，可以注释掉）
                    // }                    
                    // 核心：直接写入 ffplay 的标准输入
                    // 增加 writable 检查和错误监听
                    if (currentPlayer && currentPlayer.stdin && currentPlayer.stdin.writable) {
                        currentPlayer.stdin.write(audioBuffer, (err) => {
                            if (err) {
                                // 这里的错误通常是因为进程刚被 kill，保持静默即可
                                console.log("本次数据碎片写入被拦截（进程已关闭）");
                            }
                        });
                    }
                }
            }
        }
        // 继续下一轮对话（server主动发了turnComplete字段）
        if (json.serverContent?.turnComplete) {
            rl.prompt();
        }

        // 打印元数据 (可选)
        if (json.usageMetadata) {
            console.log(`\n📊 本轮对话消耗 Tokens: ${json.usageMetadata.totalTokenCount}`);
        }
    } catch (e) {
        console.error("❌ 解析失败:", e.message, "原始数据:", rawData);
        console.error(e.stack);        
    }
};

// 错误处理
socket.onerror = (error) => {
  console.error("❌ WebSocket 错误:", error);
};

// 关闭处理
socket.onclose = (event) => {
  console.log(`🔌 连接已关闭: 代码=${event.code}, 原因=${event.reason}`);
};

// 处理用户命令行输入
let currentBuffer = []; // 可选：用于管理音频缓冲
rl.on('line', (line) => { // line就表示回车了
    const input = line.trim();
    if (input.toLowerCase() === 'exit') {
        socket.close();
        process.exit(0);
    }
    // 无论是语音还是文本模式，按下回车都执行“打断”
    // --- 打断逻辑 --- 这是Gemini多模AI的强大之处，可以被打断哦
    //player.stdin.end();  这样会让ffplay彻底无法出声（不可逆）
    currentPlayer.kill();
    currentPlayer = startPlayer();
    console.log("🤫 正在思考新问题...");

    if (!IS_VOICE_MODE && input) {
        socket.send(JSON.stringify({
            client_content: {
                turns: [{ role: "user", parts: [{ text: input }] }],
                turn_complete: true // 流式交互的必须，Client端说完要发送turnComplete字段，否则AI server会一直等待。。
            }
        }));
    } else if (IS_VOICE_MODE) {
        // 语音模式下，回车可以作为“手动结束这一回合”的信号（可选）
        console.log("🤫 已打断当前播放");
    }
    // 发送完立即显示提示符，允许用户在 AI 说话时继续输入
    rl.prompt();
    } 
);
