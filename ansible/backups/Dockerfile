FROM alpine:3.24

# ansible pinned to the version validated in this repo (2026-07-09, ansible-core
# 2.21.0) -- an unpinned `apk add ansible` on `alpine:latest` let a routine
# redeploy silently jump ansible-core versions and surface several latent
# take_backups.yml bugs at once. Base image pinned to the matching Alpine
# release too, since the exact package version below is only guaranteed to
# exist in that release's repo index.
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ansible=14.0.0-r0 \
    openssh-client

WORKDIR /ansible
COPY ansible/ /ansible/

# Create crontabs for root user
RUN echo "0 3 * * * /ansible/backups/run-backup-playbook.sh >> /var/log/cron.log 2>&1" >> /etc/crontabs/root

ENTRYPOINT ["crond", "-f", "-d", "8"]