FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 核心修复：安装 gcompat (让Xray能运行), iproute2, coreutils, curl, bash, openssl
RUN apk add --no-cache gcompat iproute2 coreutils curl bash openssl

# 复制依赖描述文件
COPY package.json ./

# 安装 Node.js 依赖
RUN npm install --production

# 复制核心代码
COPY index.js ./

# 暴露 Hugging Face 标准端口
EXPOSE 7860

# 启动命令
CMD ["npm", "start"]
