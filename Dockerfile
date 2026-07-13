# JobPilot-web — small Node 22 image. node:sqlite is built in, no native build.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
# Persist the SQLite DB on a mounted volume in production (see render.yaml).
ENV JOBPILOT_DATA_DIR=/data
VOLUME /data
EXPOSE 4400
CMD ["node", "src/server.js"]
