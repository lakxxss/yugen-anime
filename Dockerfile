FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.html app.js styles.css server.js ./
ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 10000
CMD ["node", "server.js"]

