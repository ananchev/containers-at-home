```mermaid
---
config:
    noteAlign: left
---
sequenceDiagram
    participant Ansible_Control as Ansible Control Node
    participant Target_Host as Target Host
    participant Docker_Container as Docker Container
    participant Onsite_Backup as Onsite Backup
    participant S3_Glacier as AWS S3 Glacier

    Ansible_Control->>Target_Host: Execute Playbook
    loop For each application in backup_definitions.yml
        Target_Host->>Target_Host: Set backup timestamp
        loop For each command in backup_commands
            Target_Host->>Docker_Container: Run backup command inside container
        end
        loop For each action in copy_actions
            Docker_Container->>Target_Host: Copy file from container to host using docker cp
        end
        Target_Host->>Target_Host: Find backups to delete 
        alt Backups to delete exist
            Target_Host->>Target_Host: Remove old backups (only last three are kept)
        end
        Target_Host->>Target_Host: Append backup log entry
    end
    Target_Host->>Onsite_Backup: Run rsync to sync data from host to onsite backup location
    alt Today is Sunday
        Target_Host->>S3_Glacier: Run rclone to backup to offsite AWS S3 Glacier
    end
    Target_Host-->>Ansible_Control: Playbook execution complete
```

## Build the backup node image
```shell
docker build -f ansible/backups/Dockerfile -t backup-node .
```

## Run the backup node container
Make sure to create the ```vault.pass``` and ```ssh.key``` files before running the container. 
```shell
docker run \
    --name=containers-backup-node \
    -d \
    -e ANSIBLE_HOST_KEY_CHECKING=False \
    -v path/to/vault.pass:/ansible/vault.pass:ro,Z \
    -v path/to/container/host/ssh/key:/ansible/container_host_ssh.key:ro,Z \
    -v /etc/localtime:/etc/localtime:ro \
    backup-node
```
