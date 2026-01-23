FROM alpine:latest

RUN apk add --no-cache \
    python3 \
    py3-pip \
    ansible \
    openssh-client

WORKDIR /ansible
COPY ansible/ /ansible/

# Create crontabs for root user
RUN echo "0 3 * * * /ansible/backups/run-backup-playbook.sh >> /var/log/cron.log 2>&1" >> /etc/crontabs/root

ENTRYPOINT ["crond", "-f", "-d", "8"]