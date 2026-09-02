FROM node:20-alpine

WORKDIR /app

# Copy package files dulu biar layer cache Docker kepakai optimal
# (dependency nggak di-reinstall tiap kali cuma kode yang berubah)
COPY package*.json ./
RUN npm install --omit=dev

# Copy sisa source code
COPY . .

# Folder tempat .bot-state.json disimpen — bakal di-mount sebagai persistent volume
# di Northflank supaya nggak hilang tiap kali container restart/redeploy
RUN mkdir -p /app/data

CMD ["node", "index.js"]
