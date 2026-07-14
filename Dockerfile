FROM node:22-alpine

WORKDIR /app

# Install production deps first so this layer caches across code changes.
COPY package*.json ./
RUN npm ci --omit=dev --omit=optional

COPY src ./src
COPY seed.js ./

# Uploads are written to disk. On Render/Railway/Fly the filesystem is EPHEMERAL:
# every deploy and restart wipes it, so prescriptions and reports vanish while the
# database keeps pointing at them. Mount a volume here, or move uploads to S3,
# before this handles real patients.
RUN mkdir -p /app/uploads
VOLUME ["/app/uploads"]

ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000

# The server refuses to boot without JWT_SECRET and MONGODB_URI — pass them in:
#   docker run -p 5000:5000 -e MONGODB_URI=... -e JWT_SECRET=... heritage-api
# Do NOT set DEV_OTP in production: with it set, any phone number logs in with it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:5000/api/health || exit 1

CMD ["node", "src/server.js"]
