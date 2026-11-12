FROM alpine:3.24

# ansible-core and its one collection are pinned to versions validated in this repo.
# An unpinned `apk add ansible` on `alpine:latest` once let a routine redeploy jump
# ansible-core versions and surface several latent take_backups.yml bugs at once.
#
# ansible-core 2.22.0 (2026-11-12) comes from PyPI, not apk: Alpine 3.24 only ships
# 2.21.0, whose module_utils crash on a Python 3.15 target ("module 'dataclasses'
# has no attribute '_is_type'") -- that silently stopped vhost2's backups after its
# Fedora 45 upgrade. 2.22.0 was tested against every backup host's Python (3.11
# unas .. 3.15 vhost2) and needs Python >= 3.13 on the controller (this image: 3.14).
# community.docker 5.2.0 is the version the previous `ansible=14.0.0-r0` bundle
# shipped; it is the only collection take_backups.yml uses (docker_container_exec).
# Python deps come from apk (no compiler needed); the venv only adds ansible-core.
RUN apk add --no-cache \
    python3 \
    py3-pip \
    py3-cryptography \
    py3-jinja2 \
    py3-packaging \
    py3-resolvelib \
    py3-yaml \
    openssh-client \
 && python3 -m venv --system-site-packages /opt/ansible \
 && /opt/ansible/bin/pip install --no-cache-dir ansible-core==2.22.0 \
 && /opt/ansible/bin/ansible-galaxy collection install -p /usr/share/ansible/collections community.docker:==5.2.0 \
 && ln -s /opt/ansible/bin/ansible* /usr/local/bin/
# symlinks rather than ENV PATH: the 03:00 job runs under busybox crond, not a login shell

WORKDIR /ansible
COPY ansible/ /ansible/

# Create crontabs for root user
RUN echo "0 3 * * * /ansible/backups/run-backup-playbook.sh >> /var/log/cron.log 2>&1" >> /etc/crontabs/root

ENTRYPOINT ["crond", "-f", "-d", "8"]
