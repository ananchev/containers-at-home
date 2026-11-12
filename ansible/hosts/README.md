# Host management

Playbooks for the **hosts themselves** (OS packages, container runtime, boot/kernel
safeguards), as opposed to `../applications/`, which deploys containers onto them.

Run them like the app playbooks, prefixing the name with `hosts/`:

```
./run-playbook.sh <inventory> hosts/<playbook> <private_key> [extra ansible args]
```

| playbook | what it does | used on |
|---|---|---|
| `pre-requisites-podman.yml` | podman + `podman-docker` (Docker-API socket for the `community.docker` playbooks), `podman-restart`, firewalld trust for container subnets. Optional host vars: `podman_graphroot`, `podman_require_mounts`, `podman_socket_group` / `podman_socket_users` | pi5, vhost2, vhost |
| `boot-safeguard.yml` | kernel args `panic_on_oops=1 panic=10` (an oops reboots instead of hanging), `systemd-pstore`, and `boot-alert`: Telegram message on the boot after an unclean end (no clean shutdown logged, or kernel oops/BUG/panic) | vhost (candidate: vhost2) |
| `pre-requisites-coreos.yml` | CoreOS host prep (python for ansible, …) | fed |
| `pre-requisites-unraid.yml` | Unraid host prep | unas |
| `pre-requisites.yml` | pointer to the OS-specific ones | – |

Files copied to hosts live in `files/` (found automatically by `copy: src:`).
Host-specific knobs go in `../inventories/<host>/host_vars/<host>.yml`.

Vault and shared vars come from `../inventories/<host>/group_vars` (symlink to
`inventories/group_vars/`, created by `run-playbook.sh`), so playbooks here need no `vars_files`.
