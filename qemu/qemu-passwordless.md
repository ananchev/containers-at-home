Use the visudo command to safely edit the sudoers file:
```
sudo visudo
```
Add a line that allows the current user to execute the specific script without a password:

```
your_user ALL=(ALL) NOPASSWD: /opt/homebrew/bin/qemu-system-aarch64
```
