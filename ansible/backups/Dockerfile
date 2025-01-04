FROM alpine:latest

RUN apk add --no-cache \
    python3 \
    py3-pip \
    ansible \
    openssh-client 

WORKDIR /ansible
COPY ansible/ /ansible/

## Touch to create empty files, needed the for single file mounts to work when running the container 
# RUN touch /ansible/vault.pass
# RUN touch /ansible/backups/ssh_private.key

# Buildkit is required for the heredoc syntax below to work
COPY <<'EOF' /ansible/backups/run-backup-playbook.sh
#!/bin/sh
ansible-playbook \
    -i /ansible/inventories/fed \
    --private-key /ansible/container_host_ssh.key \
    --vault-password-file /ansible/vault.pass \
    /ansible/backups/take_backups.yml
EOF
RUN chmod +x /ansible/backups/run-backup-playbook.sh

# Create crontabs for root user
RUN echo "0 3 * * * /ansible/backups/run-backup-playbook.sh >> /var/log/cron.log 2>&1" >> /etc/crontabs/root

ENTRYPOINT ["crond", "-f", "-d", "8"]