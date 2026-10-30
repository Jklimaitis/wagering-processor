FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY --chown=bun:bun . .
USER bun
CMD ["bun", "run", "start"]
