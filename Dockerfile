FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/
# data/ i logs/ są mountowane jako volumes - COPY tylko defaults na wypadek braku volumeu
COPY data/ ./data/
RUN mkdir -p logs

EXPOSE 3000
CMD ["node", "src/index.js"]
