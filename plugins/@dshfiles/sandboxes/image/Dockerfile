# The default sandbox image: Node for the guest agent, git for the copy in and out, bash for the agent's commands.
# The sandbox user is uid 1000 (`node` in this base image); the workspace volume is chowned to it at create.
FROM node:22-alpine
RUN apk add --no-cache git bash ca-certificates
USER 1000:1000
