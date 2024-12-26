docker run \
    --name=containers-backup-node \
    -d \
    -e ANSIBLE_HOST_KEY_CHECKING=False \
    -v $(pwd)/vault.pass:/ansible/vault.pass:ro,Z \
    -v path/to/container/host/ssh/key:/ansible/container_host_ssh.key:ro,Z \
    -v /etc/localtime:/etc/localtime:ro \
    backup-node