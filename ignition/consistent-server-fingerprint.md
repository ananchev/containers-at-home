Using a consistent SSH host key pair for the VM ensures that every time it is re-instantiated, its  fingerprint remains the same. This way there will be no issues with client warnings about changed host keys.

1. Generate SSH host keys
```bash
ssh-keygen -q -N "" -t dsa -f coreos-ssh_host_dsa_key
ssh-keygen -q -N "" -t rsa -b 4096 -f coreos-ssh_host_rsa_key
ssh-keygen -q -N "" -t ecdsa -f coreos-ssh_host_ecdsa_key
ssh-keygen -q -N "" -t ed25519 -f coreos-ssh_host_ed25519_key
```

2. Update Butane configuration to set the SSH host keys using the set generated in the step above.
When the SSH daemon starts there is no trigger for sshd-keygen.service to generate new keys and the host fingerprint remains the same every time when the VM is re-instantiated. 
```yml
variant: fcos
version: 1.4.0
storage:
  files:
    - path: /etc/ssh/ssh_host_rsa_key
      mode: 0600
      contents:
        local: coreos-ssh_host_rsa_key
    - path: /etc/ssh/ssh_host_rsa_key.pub
      mode: 0644
      contents:
        local: coreos-ssh_host_rsa_key.pub
    - path: /etc/ssh/ssh_host_dsa_key
      mode: 0600
      contents:
        local: coreos-ssh_host_dsa_key
    - path: /etc/ssh/ssh_host_dsa_key.pub
      mode: 0644
      contents:
        local: coreos-ssh_host_dsa_key.pub
    - path: /etc/ssh/ssh_host_ecdsa_key
      mode: 0600
      contents:
        local: coreos-ssh_host_ecdsa_key
    - path: /etc/ssh/ssh_host_ecdsa_key.pub
      mode: 0644
      contents:
        local: coreos-ssh_host_ecdsa_key.pub
    - path: /etc/ssh/ssh_host_ed25519_key
      mode: 0600
      contents:
        local: coreos-ssh_host_ed25519_key
    - path: /etc/ssh/ssh_host_ed25519_key.pub
      mode: 0644
      contents:
        local: coreos-ssh_host_ed25519_key.pub
```

3. Generate the ignition configuration file
```bash
butane --files-dir . --pretty --strict config.bu > config.ign 
```