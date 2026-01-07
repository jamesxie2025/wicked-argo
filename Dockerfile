FROM node:18-alpine

# 设置工作目录
WORKDIR /app

# 安装必要的系统工具 (curl, bash, openssl 等)
# 这一步对于脚本中可能调用的系统命令至关重要
RUN apk add --no-cache bash curl openssl coreutils

# 复制依赖文件并安装
COPY package.json ./
RUN npm install --production

# 复制核心代码
COPY index.js ./

# 暴露端口 (虽然 Argo 不需要入站端口，但保留以备不时之需)
EXPOSE 3000

# 启动命令
CMD ["npm", "start"]
