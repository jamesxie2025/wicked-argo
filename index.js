const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
const app = express();

// ================== ENV ==================
const ENV = {
    FILE_PATH: path.join(os.tmpdir(), 'wicked-argo'), // cloud safe path
    PORT: process.env.PORT || 8001,                  // leapcell port
    UUID: process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913',
    ARGO_DOMAIN: process.env.ARGO_DOMAIN || '',
    ARGO_AUTH: process.env.ARGO_AUTH || '',
    ARGO_PORT: 8001,                                 // internal proxy port
    CFIP: 'www.visa.com.sg',
    CFPORT: 443,
    NAME: 'Wicked'
};

const FILES = {
    DIR: ENV.FILE_PATH,
    WEB: path.join(ENV.FILE_PATH, 'web'),
    BOT: path.join(ENV.FILE_PATH, 'bot'),
    CONFIG: path.join(ENV.FILE_PATH, 'config.json'),
    SUB: path.join(ENV.FILE_PATH, 'sub.txt')
};

// ================== INIT DIR ==================
if (!fs.existsSync(FILES.DIR)) {
    fs.mkdirSync(FILES.DIR, { recursive: true });
}

// ================== ARCH ==================
function getArch() {
    const arch = os.arch();
    return ['arm', 'arm64', 'aarch64'].includes(arch) ? 'arm' : 'amd';
}

// ================== DOWNLOAD ==================
async function downloadFile(url, dest) {
    const writer = fs.createWriteStream(dest);
    try {
        const response = await axios({
            method: 'get',
            url,
            responseType: 'stream',
            timeout: 20000
        });

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                fs.chmodSync(dest, 0o775);
                console.log(`[Init] Downloaded: ${path.basename(dest)}`);
                resolve();
            });
            writer.on('error', reject);
        });

    } catch (err) {
        console.error(`[Error] Download failed: ${url} - ${err.message}`);
    }
}

// ================== CONFIG ==================
function generateConfig() {
    const config = {
        log: { access: "/dev/null", error: "/dev/null", loglevel: "none" },
        inbounds: [
            {
                port: ENV.ARGO_PORT,
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

// ================== START SERVICES ==================
async function startServices() {
    const arch = getArch();
    const webUrl = `https://${arch === 'arm' ? 'arm64' : 'amd64'}.ssss.nyc.mn/web`;
    const botUrl = `https://${arch === 'arm' ? 'arm64' : 'amd64'}.ssss.nyc.mn/bot`;

    console.log(`[Init] System Architecture: ${arch}`);

    // download
    await Promise.all([
        downloadFile(webUrl, FILES.WEB),
        downloadFile(botUrl, FILES.BOT)
    ]);

    // config
    generateConfig();

    // start xray
    console.log(`[Start] Starting Xray on port ${ENV.ARGO_PORT}`);
    exec(`nohup ${FILES.WEB} -c ${FILES.CONFIG} >/dev/null 2>&1 &`);

    // start tunnel
    if (ENV.ARGO_AUTH) {
        console.log(`[Start] Starting Fixed Tunnel`);
        exec(`nohup ${FILES.BOT} tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${ENV.ARGO_AUTH} >/dev/null 2>&1 &`);
    } else {
        console.log(`[Start] Starting Quick Tunnel`);
        exec(`nohup ${FILES.BOT} tunnel --edge-ip-version auto --no-autoupdate --protocol http2 --url http://localhost:${ENV.ARGO_PORT} >/dev/null 2>&1 &`);
    }

    // generate sub
    setTimeout(() => {
        const link = `vless://${ENV.UUID}@${ENV.CFIP}:${ENV.CFPORT}?encryption=none&security=tls&sni=${ENV.ARGO_DOMAIN}&type=ws&host=${ENV.ARGO_DOMAIN}&path=%2Fvless-argo#${ENV.NAME}`;
        fs.writeFileSync(FILES.SUB, Buffer.from(link).toString('base64'));
        console.log(`[Info] Subscription generated`);
    }, 3000);
}

// ================== ROUTES ==================
app.get("/", (req, res) => {
    res.send("Wicked Argo Running");
});

app.get("/sub", (req, res) => {
    if (fs.existsSync(FILES.SUB)) {
        res.send(fs.readFileSync(FILES.SUB));
    } else {
        res.send("Generating...");
    }
});

// ================== SERVER ==================
app.listen(ENV.PORT, '0.0.0.0', () => {
    console.log(`[Server] Listening on port ${ENV.PORT}`);
    startServices();
});
