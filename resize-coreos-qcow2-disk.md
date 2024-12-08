By default the coreos qcow2 disk image is 10GB in size. 
Looks something like this
```shell
[root@coreos ~]# lsblk
NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS
vda      8:0    0   10G  0 disk 
├─vda1   8:1    0    1M  0 part 
├─vda2   8:2    0  127M  0 part 
├─vda3   8:3    0  384M  0 part /boot
└─vda4   8:4    0  9.5G  0 part /var
                                /sysroot/ostree/deploy/fedora-coreos/var
                                /usr
                                /etc
                                /
                                /sysroot
```

In order to expand:
1. Shut down the VM 
2. Expand the disk image
    * to absolute size
    ```shell
    qemu-img resize disk.qcow2 100G
    ```
    * or by increment

    ```shell
    qemu-img resize disk.qcow2 +10G
    ```

3. Boot up the VM and open root shell
```shell
sudo -su
```

After the virtual disk was expanded output of ```lsblk``` would be like below. Note vda size is 100GB now.
```shell
[root@coreos ~]# lsblk
NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS
vda      8:0    0  100G  0 disk 
├─vda1   8:1    0    1M  0 part 
├─vda2   8:2    0  127M  0 part 
├─vda3   8:3    0  384M  0 part /boot
└─vda4   8:4    0  9.5G  0 part /var
                                /sysroot/ostree/deploy/fedora-coreos/var
                                /usr
                                /etc
                                /
                                /sysroot
```
4. Grow the fourth partition (where our OS root fs lives)
```shell 
growpart /dev/vda 4
```

5. Start an isolated namespace of the mount table for the current shell. This way we can remount /sysroot as read-write 
```shell
unshare --mount
```

6. Remount /sysroot as Read-Write
```shell
mount -o remount,rw /sysroot
```

7. Resize the XFS filesystem to utilize the space on expanded vda4 partition.
```shell
xfs_growfs /sysroot
```
xfs_growfs  updates the filesystem metadata on disk to reflect the new size and requires write permissions on the mounted filesystem. We ensure this with the ```rw`` remount in an isolated namespace.

8. After ```xfs_growfs``` size of vda4 partition is consuming the available disk space on vda.
```shell
[root@coreos ~]# lsblk
NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS
vda      8:0    0  100G  0 disk 
├─vda1   8:1    0    1M  0 part 
├─vda2   8:2    0  127M  0 part 
├─vda3   8:3    0  384M  0 part /boot
└─vda4   8:4    0 99.5G  0 part /var
                                /sysroot/ostree/deploy/fedora-coreos/var
                                /usr
                                /etc
                                /
                                /sysroot
```