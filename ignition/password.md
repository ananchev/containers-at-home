Fedora CoreOS ships with no default passwords. You can use a Butane config to set a password for a local user as  password_hash for one or more users:

```yml
passwd:
  users:
    - name: core
      password_hash: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDHn2eh..."
```
To generate a secure password hash, use mkpasswd from the whois package. The yescrypt hashing method is recommended for new passwords.
Your Linux distro may ship a different mkpasswd implementation; you can ensure you’re using the correct one by running it from a container:

```shell
$ podman run -ti --rm quay.io/coreos/mkpasswd --method=yescrypt
Password:
$y$j9T$A0Y3wwVOKP69S.1K/zYGN.$S596l11UGH3XjN...
```