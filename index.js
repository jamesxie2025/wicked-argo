const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const { promisify } = require("util");

const execAsync = promisify(exec);
const app = express();

// ================= 环境变量配置 =================
const ENV = {
    UPLOAD_URL: process.env.UPLOAD_URL || '',
    PROJECT_URL: process.env.PROJECT_URL || '',
    FILE_PATH: process.env.FILE_PATH || './tmp',
    SUB_PATH: process.env.SUB_PATH || 'sub',
    PORT: process.env.PORT || 3000,
    // 默认 UUID，生产环境请务必修改
    UUID: process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913',
    NEZHA_SERVER: process.env.NEZHA_SERVER || '',
    NEZHA_PORT: process.env.NEZHA_PORT || '',
    NEZHA_KEY: process.env.NEZHA_KEY || '',
    ARGO_DOMAIN: process.env.ARGO_DOMAIN || '',
    ARGO_AUTH: process.env.ARGO_AUTH || '',
    ARGO_PORT: process.env.ARGO_PORT || 8001,
    CFIP: process.env.CFIP || 'www.visa.com.sg', // 使用优选域名加速
    CFPORT: process.env.CFPORT || 443,
    NAME: process.env.NAME || 'Wicked-Node'
};

// ================= 文件路径定义 =================
const FILES = {
    DIR: ENV.FILE_PATH,
    WEB: path.join(ENV.FILE_PATH, 'web'), // Xray core
    BOT: path.join(ENV.FILE_PATH, 'bot'), // Cloudflared
    NPM: path.join(ENV.FILE_PATH, 'npm'), // Nezha Agent (TLS)
    PHP: path.join(ENV.FILE_PATH, 'php'), // Nezha Agent (Non-TLS)
    CONFIG: path.join(ENV.FILE_PATH, 'config.json'),
    TUNNEL_YML: path.join(ENV.FILE_PATH, 'tunnel.yml'),
    BOOT_LOG: path.join(ENV.FILE_PATH, 'boot.log'),
    SUB_TXT: path.join(ENV.FILE_PATH, 'sub.txt')
};

// ================= 核心工具函数 =================

// 初始化目录
if (!fs.existsSync(FILES.DIR)) {
    fs.mkdirSync(FILES.DIR, { recursive: true });
    console.log(`[Init] Created directory: ${FILES.DIR}`);
}

// 获取系统架构 (用于下载对应二进制)
function getArch() {
    const arch = os.arch();
    return (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') ? 'arm' : 'amd';
}

// 下载文件通用函数
async function downloadFile(url, dest) {
    console.log(`[Download] Starting: ${path.basename(dest)} from ${url}`);
    const writer = fs.createWriteStream(dest);
    try {
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream',
            timeout: 20000 // 20秒超时
        });
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                writer.close();
                // 赋予执行权限
                fs.chmodSync(dest, 0o775);
                console.log(`[Download] Success: ${path.basename(dest)}`);
                resolve();
            });
            writer.on('error', (err) => {
                fs.unlink(dest, () => {});
                reject(err);
            });
        });
    } catch (error) {
        throw new Error(`Download failed for ${url}: ${error.message}`);
    }
}

// 生成 Xray 配置文件 (加速核心)
function generateXrayConfig() {
    const config = {
        log: { access: "/dev/null", error: "/dev/null", loglevel: "none" },
        inbounds: [
            // 核心入口：Argo 隧道对接端口
            {
                port: parseInt(ENV.ARGO_PORT),
                protocol: "vless",
                settings: {
                    clients: [{ id: ENV.UUID, flow: "xtls-rprx-vision" }], // Vision 流控加速
                    decryption: "none",
                    fallbacks: [
                        { dest: 3001 },
                        { path: "/vless-argo", dest: 3002 },
                        { path: "/vmess-argo", dest: 3003 },
                        { path: "/trojan-argo", dest: 3004 }
                    ]
                },
                streamSettings: { network: "tcp" }
            },
            // 回落端口配置
            {
                port: 3001, listen: "127.0.0.1", protocol: "vless",
                settings: { clients: [{ id: ENV.UUID }] },
                streamSettings: { network: "tcp", security: "none" }
            },
            {
                port: 3002, listen: "127.0.0.1", protocol: "vless",
                settings: { clients: [{ id: ENV.UUID, level: 0 }] },
                streamSettings: { network: "ws", security: "none", wsSettings: { path: "/vless-argo" } }
            },
            {
                port: 3003, listen: "127.0.0.1", protocol: "vmess",
                settings: { clients: [{ id: ENV.UUID, alterId: 0 }] },
                streamSettings: { network: "ws", wsSettings: { path: "/vmess-argo" } }
            },
            {
                port: 3004, listen: "127.0.0.1", protocol: "trojan",
                settings: { clients: [{ password: ENV.UUID }] },
                streamSettings: { network: "ws", security: "none", wsSettings: { path: "/trojan-argo" } }
            }
        ],
        // 使用高效 DNS
        dns: { servers: ["8.8.8.8", "1.1.1.1"] },
        outbounds: [
            { protocol: "freedom", tag: "direct" },
            { protocol: "blackhole", tag: "block" }
        ]
    };
    fs.writeFileSync(FILES.CONFIG, JSON.stringify(config, null, 2));
    console.log(`[Config] Xray config generated.`);
}

// 启动 Xray
async function startXray() {
    try {
        // 后台运行，丢弃日志
        const cmd = `nohup ${FILES.WEB} -c ${FILES.CONFIG} >/dev/null 2>&1 &`;
        await execAsync(cmd);
        console.log(`[Service] Xray started.`);
    } catch (err) {
        console.error(`[Error] Failed to start Xray: ${err.message}`);
    }
}

// 启动 Nezha Agent
async function startNezha() {
    if (!ENV.NEZHA_SERVER || !ENV.NEZHA_KEY) {
        console.log(`[Nezha] Skipped (Missing Server or Key).`);
        return;
    }

    try {
        let cmd = '';
        if (ENV.NEZHA_PORT) {
            // V0 Agent (NPM)
            const tlsFlag = ['443', '8443', '2096', '2053'].includes(ENV.NEZHA_PORT) ? '--tls' : '';
            cmd = `nohup ${FILES.NPM} -s ${ENV.NEZHA_SERVER}:${ENV.NEZHA_PORT} -p ${ENV.NEZHA_KEY} ${tlsFlag} --skip-conn --skip-procs --disable-auto-update --report-delay 4 >/dev/null 2>&1 &`;
        } else {
            // V1 Agent (PHP) - Config YAML approach
            const tlsState = ['443', '8443', '2096'].includes(ENV.NEZHA_SERVER.split(':').pop()) ? 'true' : 'false';
            const yamlConfig = `
client_secret: ${ENV.NEZHA_KEY}
server: ${ENV.NEZHA_SERVER}
tls: ${tlsState}
skip_connection_count: true
skip_procs_count: true
disable_auto_update: true
uuid: ${ENV.UUID}
`;
            fs.writeFileSync(path.join(FILES.DIR, 'nezha.yaml'), yamlConfig);
            cmd = `nohup ${FILES.PHP} -c ${path.join(FILES.DIR, 'nezha.yaml')} >/dev/null 2>&1 &`;
        }
        await execAsync(cmd);
        console.log(`[Service] Nezha Agent started.`);
    } catch (err) {
        console.error(`[Error] Failed to start Nezha: ${err.message}`);
    }
}

// 启动 Cloudflare Argo
async function startArgo() {
    if (!fs.existsSync(FILES.BOT)) return;

    let cmd = '';
    // 1. 固定 Token 方式
    if (ENV.ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
        console.log(`[Argo] Using Fixed Tunnel (Token).`);
        cmd = `nohup ${FILES.BOT} tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${ENV.ARGO_AUTH} >/dev/null 2>&1 &`;
    } 
    // 2. JSON 密钥文件方式
    else if (ENV.ARGO_AUTH.includes('TunnelSecret')) {
        console.log(`[Argo] Using Fixed Tunnel (JSON).`);
        fs.writeFileSync(path.join(FILES.DIR, 'tunnel.json'), ENV.ARGO_AUTH);
        const yaml = `
tunnel: ${JSON.parse(ENV.ARGO_AUTH).TunnelID}
credentials-file: ${path.join(FILES.DIR, 'tunnel.json')}
protocol: http2
ingress:
  - hostname: ${ENV.ARGO_DOMAIN}
    service: http://localhost:${ENV.ARGO_PORT}
    originRequest:
      noTLSVerify: true
  - service: http_status:404
`;
        fs.writeFileSync(FILES.TUNNEL_YML, yaml);
        cmd = `nohup ${FILES.BOT} tunnel --edge-ip-version auto --config ${FILES.TUNNEL_YML} run >/dev/null 2>&1 &`;
    } 
    // 3. 临时隧道 (Quick Tunnel)
    else {
        console.log(`[Argo] Using Quick Tunnel.`);
        cmd = `nohup ${FILES.BOT} tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --logfile ${FILES.BOOT_LOG} --loglevel info --url http://localhost:${ENV.ARGO_PORT} >/dev/null 2>&1 &`;
    }

    try {
        await execAsync(cmd);
        console.log(`[Service] Argo Tunnel started.`);
        // 如果是临时隧道，需要等待并提取域名
        if (!ENV.ARGO_AUTH && !ENV.ARGO_DOMAIN) {
            await extractQuickTunnelDomain();
        } else {
            generateSubscription(ENV.ARGO_DOMAIN);
        }
    } catch (err) {
        console.error(`[Error] Failed to start Argo: ${err.message}`);
    }
}

// 提取临时域名
async function extractQuickTunnelDomain() {
    console.log(`[Argo] Waiting for Quick Tunnel domain...`);
    await new Promise(r => setTimeout(r, 5000)); // 等待日志生成

    for (let i = 0; i < 10; i++) { // 尝试10次
        try {
            if (fs.existsSync(FILES.BOOT_LOG)) {
                const logs = fs.readFileSync(FILES.BOOT_LOG, 'utf8');
                const match = logs.match(/https?:\/\/([^ ]*trycloudflare\.com)/);
                if (match) {
                    const domain = match[1];
                    console.log(`[Argo] Quick Domain Found: ${domain}`);
                    generateSubscription(domain);
                    return;
                }
            }
        } catch (e) {}
        await new Promise(r => setTimeout(r, 2000));
    }
    console.error(`[Error] Failed to extract Quick Tunnel domain.`);
}

// 生成订阅节点链接
async function generateSubscription(domain) {
    const nodeName = `${ENV.NAME}-${getArch()}`;
    const vlessLink = `vless://${ENV.UUID}@${ENV.CFIP}:${ENV.CFPORT}?encryption=none&security=tls&sni=${domain}&fp=firefox&type=ws&host=${domain}&path=%2Fvless-argo%3Fed%3D2560#${nodeName}`;
    
    // 生成 VMess JSON
    const vmessConfig = {
        v: "2", ps: nodeName, add: ENV.CFIP, port: ENV.CFPORT, id: ENV.UUID, aid: "0",
        scy: "none", net: "ws", type: "none", host: domain, path: "/vmess-argo?ed=2560",
        tls: "tls", sni: domain, alpn: "", fp: "firefox"
    };
    const vmessLink = `vmess://${Buffer.from(JSON.stringify(vmessConfig)).toString('base64')}`;
    
    const trojanLink = `trojan://${ENV.UUID}@${ENV.CFIP}:${ENV.CFPORT}?security=tls&sni=${domain}&fp=firefox&type=ws&host=${domain}&path=%2Ftrojan-argo%3Fed%3D2560#${nodeName}`;

    const content = `${vlessLink}\n${vmessLink}\n${trojanLink}`;
    const base64Content = Buffer.from(content).toString('base64');

    fs.writeFileSync(FILES.SUB_TXT, base64Content);
    console.log(`[Sub] Subscription generated. Access at /${ENV.SUB_PATH}`);
    
    // 如果配置了自动上传
    if (ENV.UPLOAD_URL) {
        await uploadNodes(content, ENV.UPLOAD_URL);
    }
}

async function uploadNodes(nodes, url) {
    try {
        // 简单实现上传逻辑，具体需配合接收端
        await axios.post(`${url}/api/add-nodes`, { nodes: nodes });
        console.log(`[Upload] Nodes uploaded successfully.`);
    } catch (e) {
        // console.error(`[Upload] Failed: ${e.message}`);
    }
}

// 清理敏感文件 (可选)
function cleanTracks() {
    setTimeout(() => {
        // 这里可以删除二进制文件以隐藏进程，但会影响容器重启。
        // 为了稳定性，我们只删除配置文件和日志
        const filesToDelete = [FILES.BOOT_LOG, FILES.TUNNEL_YML, path.join(FILES.DIR, 'tunnel.json')];
        filesToDelete.forEach(f => {
            if (fs.existsSync(f)) fs.unlinkSync(f);
        });
        console.log(`[Cleanup] Temp files removed.`);
    }, 60000);
}

// ================= 主流程 =================

async function main() {
    const arch = getArch();
    const urls = {
        // 这里使用的是原作者的镜像源，你也可以换成自己的或者官方的 GitHub Release
        web: `https://${arch === 'arm' ? 'arm64' : 'amd64'}.ssss.nyc.mn/web`,
        bot: `https://${arch === 'arm' ? 'arm64' : 'amd64'}.ssss.nyc.mn/bot`,
        npm: `https://${arch === 'arm' ? 'arm64' : 'amd64'}.ssss.nyc.mn/agent`, // Nezha V0
        php: `https://${arch === 'arm' ? 'arm64' : 'amd64'}.ssss.nyc.mn/v1`    // Nezha V1
    };

    try {
        // 1. 下载核心文件
        await Promise.all([
            downloadFile(urls.web, FILES.WEB),
            downloadFile(urls.bot, FILES.BOT),
            (ENV.NEZHA_PORT ? downloadFile(urls.npm, FILES.NPM) : (ENV.NEZHA_SERVER ? downloadFile(urls.php, FILES.PHP) : Promise.resolve()))
        ]);

        // 2. 生成配置并启动
        generateXrayConfig();
        await startXray();
        await startNezha();
        await startArgo();

        // 3. 清理痕迹
        cleanTracks();

    } catch (err) {
        console.error(`[Fatal Error] ${err.message}`);
    }
}

// 启动 Express 服务器
app.get("/", (req, res) => res.send("Wicked Argo is Running!"));
app.get(`/${ENV.SUB_PATH}`, (req, res) => {
    if (fs.existsSync(FILES.SUB_TXT)) {
        res.type('text/plain; charset=utf-8');
        res.send(fs.readFileSync(FILES.SUB_TXT));
    } else {
        res.status(404).send("Subscription not ready.");
    }
});

app.listen(ENV.PORT, () => {
    console.log(`[Server] Listening on port ${ENV.PORT}`);
    main(); // 启动主逻辑
});
