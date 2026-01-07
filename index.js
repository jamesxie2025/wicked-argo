const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const app = express();

// 环境变量默认值配置
const ENV = {
    FILE_PATH: './tmp',
    PORT: process.env.PORT || 7860,         // HF Web 端口
    UUID: process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913',
    ARGO_DOMAIN: process.env.ARGO_DOMAIN || '',
    ARGO_AUTH: process.env.ARGO_AUTH || '',
    ARGO_PORT: 8001,                        // 代理内部端口 (固定)
    CFIP: 'www.visa.com.sg',                // 优选 IP (生成订阅用)
    CFPORT: 443,
    NAME: 'Wicked'
};

const FILES = {
    DIR: ENV.FILE_PATH,
    WEB: path.join(ENV.FILE_PATH, 'web'),       // Xray
    BOT: path.join(ENV.FILE_PATH, 'bot'),       // Cloudflared
    CONFIG: path.join(ENV.FILE_PATH, 'config.json'),
    SUB: path.join(ENV.FILE_PATH, 'sub.txt')
};

// 初始化目录
if (!fs.existsSync(FILES.DIR)) fs.mkdirSync(FILES.DIR, { recursive: true });

// 判断架构
function getArch() {
    const arch = os.arch();
    return ['arm', 'arm64', 'aarch64'].includes(arch) ? 'arm' : 'amd';
}

// 下载文件工具
async function downloadFile(url, dest) {
    const writer = fs.createWriteStream(dest);
    try {
        const response = await axios({ method: 'get', url, responseType: 'stream', timeout: 20000 });
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                fs.chmodSync(dest, 0o775); // 赋予执行权限
                console.log(`[Init] Downloaded: ${path.basename(dest)}`);
                resolve();
            });
            writer.on('error', reject);
        });
    } catch (err) {
        console.error(`[Error] Download failed: ${url} - ${err.message}`);
    }
}

// 生成 Xray 配置 (纯净 WebSocket 模式)
function generateConfig() {
    const config = {
        log: { access: "/dev/null", error: "/dev/null", loglevel: "none" },
        inbounds: [
            {
                port: ENV.ARGO_PORT, // 8001
                listen: "127.0.0.1",
                protocol: "vless",
                settings: {
                    clients: [{ id: ENV.UUID }], 
                    decryption: "none"
                },
                streamSettings: {
                    network: "ws",
                    wsSettings: { path: "/vless-argo" }
                }
            }
        ],
        outbounds: [{ protocol: "freedom" }]
    };
    fs.writeFileSync(FILES.CONFIG, JSON.stringify(config, null, 2));
}

// 启动服务
async function startServices() {
    const arch = getArch();
    // 使用 eooce 的源，也可以换成官方 Release
    const webUrl = `https://${arch === 'arm' ? 'arm64' : 'amd64'}.ssss.nyc.mn/web`;
    const botUrl = `https://${arch === 'arm' ? 'arm64' : 'amd64'}.ssss.nyc.mn/bot`;

    console.log(`[Init] System Architecture: ${arch}`);
    
    // 1. 下载二进制
    await Promise.all([downloadFile(webUrl, FILES.WEB), downloadFile(botUrl, FILES.BOT)]);

    // 2. 生成配置
    generateConfig();

    // 3. 启动 Xray
    console.log(`[Start] Starting Xray on port ${ENV.ARGO_PORT}...`);
    exec(`nohup ${FILES.WEB} -c ${FILES.CONFIG} >/dev/null 2>&1 &`);

    // 4. 启动 Tunnel
    if (ENV.ARGO_AUTH) {
        console.log(`[Start] Starting Fixed Tunnel...`);
        // 关键：--edge-ip-version auto 自动寻找最快节点
        exec(`nohup ${FILES.BOT} tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${ENV.ARGO_AUTH} >/dev/null 2>&1 &`);
    } else {
        console.log(`[Start] Starting Quick Tunnel (No Token provided)...`);
        exec(`nohup ${FILES.BOT} tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --url http://localhost:${ENV.ARGO_PORT} >/dev/null 2>&1 &`);
    }

    // 5. 生成订阅文件
    setTimeout(() => {
        const link = `vless://${ENV.UUID}@${ENV.CFIP}:${ENV.CFPORT}?encryption=none&security=tls&sni=${ENV.ARGO_DOMAIN}&type=ws&host=${ENV.ARGO_DOMAIN}&path=%2Fvless-argo#${ENV.NAME}`;
        fs.writeFileSync(FILES.SUB, Buffer.from(link).toString('base64'));
        console.log(`[Info] Subscription generated.`);
    }, 3000);
}

// Web 服务器
app.get("/", (req, res) => res.send("Wicked Argo Running"));
app.get("/sub", (req, res) => {
    if (fs.existsSync(FILES.SUB)) res.send(fs.readFileSync(FILES.SUB));
    else res.send("Generating...");
});

app.listen(ENV.PORT, () => {
    console.log(`[Server] Listening on port ${ENV.PORT}`);
    startServices();
});
