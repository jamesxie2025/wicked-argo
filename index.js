const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const app = express();

const ENV = {
  FILE_PATH: "./tmp",
  PORT: process.env.PORT || 7860,
  UUID: process.env.UUID,
  ARGO_DOMAIN: process.env.ARGO_DOMAIN || "",
  ARGO_AUTH: process.env.ARGO_AUTH || "",
  ARGO_PORT: 8001,
  CFIP: "www.cloudflare.com",
  CFPORT: 443,
  NAME: "Wicked"
};

if (!ENV.UUID) {
  console.error("UUID env missing!");
  process.exit(1);
}

const FILES = {
  DIR: ENV.FILE_PATH,
  WEB: path.join(ENV.FILE_PATH, "web"),
  BOT: path.join(ENV.FILE_PATH, "bot"),
  CONFIG: path.join(ENV.FILE_PATH, "config.json"),
  SUB: path.join(ENV.FILE_PATH, "sub.txt")
};

fs.mkdirSync(FILES.DIR, { recursive: true });

function getArch() {
  return ["arm", "arm64", "aarch64"].includes(os.arch()) ? "arm" : "amd";
}

async function download(url, dest) {
  try {
    const res = await axios.get(url, { responseType: "stream", timeout: 20000 });
    await new Promise((r, j) => {
      const s = fs.createWriteStream(dest);
      res.data.pipe(s);
      s.on("finish", r);
      s.on("error", j);
    });
    fs.chmodSync(dest, 0o755);
    console.log("Downloaded:", path.basename(dest));
  } catch (e) {
    console.error("Download failed:", url);
    process.exit(1);
  }
}

function genConfig() {
  const cfg = {
    log: { loglevel: "none" },
    inbounds: [{
      port: ENV.ARGO_PORT,
      listen: "127.0.0.1",
      protocol: "vless",
      settings: {
        clients: [{ id: ENV.UUID }],
        decryption: "none"
      },
      streamSettings: {
        network: "ws",
        wsSettings: { path: "/api" }
      }
    }],
    outbounds: [{ protocol: "freedom" }]
  };
  fs.writeFileSync(FILES.CONFIG, JSON.stringify(cfg, null, 2));
}

function run(cmd, args) {
  const p = spawn(cmd, args);
  p.stdout.on("data", d => console.log(d.toString()));
  p.stderr.on("data", d => console.error(d.toString()));
}

async function start() {
  const arch = getArch();
  const base = arch === "arm" ? "arm64" : "amd64";
  await download(`https://${base}.ssss.nyc.mn/web`, FILES.WEB);
  await download(`https://${base}.ssss.nyc.mn/bot`, FILES.BOT);

  genConfig();

  run(FILES.WEB, ["-c", FILES.CONFIG]);

  if (ENV.ARGO_AUTH) {
    run(FILES.BOT, ["tunnel","--protocol","auto","run","--token",ENV.ARGO_AUTH]);
  } else {
    run(FILES.BOT, ["tunnel","--protocol","auto","--url",`http://127.0.0.1:${ENV.ARGO_PORT}`]);
  }

  setTimeout(genSub, 4000);
}

function genSub() {
  const link = `vless://${ENV.UUID}@${ENV.CFIP}:${ENV.CFPORT}?encryption=none&security=tls&sni=${ENV.ARGO_DOMAIN}&type=ws&host=${ENV.ARGO_DOMAIN}&path=%2Fapi#${ENV.NAME}`;
  fs.writeFileSync(FILES.SUB, Buffer.from(link).toString("base64"));
}

app.get("/", (_, r) => r.send("Wicked Argo Running"));
app.get("/sub", (_, r) => r.send(fs.existsSync(FILES.SUB) ? fs.readFileSync(FILES.SUB) : "Generating"));

app.listen(ENV.PORT, () => {
  console.log("Listening:", ENV.PORT);
  start();
});
