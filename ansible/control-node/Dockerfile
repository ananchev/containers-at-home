FROM alpine:latest

RUN apk add --no-cache bash curl cronie python3 py3-pip ansible

WORKDIR /ansible
COPY ../ /ansible/
RUN chmod +x /ansible/backups/run.sh

RUN echo "* * * * * /ansible/backups/run.sh >> /var/log/cron.log 2>&1" > /etc/crontabs/root

CMD ["crond", "-f", "-l", "2"]
