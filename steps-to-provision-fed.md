1. Create ignition configuration 
```shell
ignition/butane --pretty --files-dir ignition --strict ignition/vm/config.bu > ignition/vm/config.ign
```

2. Download latest Fedora CoreOS QEMU image for aarch64 from [here](https://fedoraproject.org/coreos/download?stream=stable&arch=aarch64#download_section).

3. Un-xz and move to the target directory on the host

4. Copy to the host folder the UEFI Firmware images.
Below source locations are for QEMU installed with homebrew.
Firmware code: ```/opt/homebrew/opt/qemu/share/qemu/edk2-aarch64-code.fd ```
Variable data: ```/opt/homebrew/opt/qemu/share/qemu/edk2-arm-vars.fd```

5. Shell script to run the vm under [QEMU console](https://github.com/ananchev/qemu-console).
```shell
#!/bin/bash

/opt/homebrew/bin/qemu-system-aarch64 \
  -serial file:/tmp/fed.serial \
  -qmp unix:/tmp/fed.sock,server,nowait \
  -M virt \
  -accel hvf \
  -cpu host \
  -smp 4 \
  -m 4096 \
  -drive file=/Volumes/nvme/qemu-vms/fed/edk2-aarch64-code.fd,if=pflash,format=raw,readonly=on \
  -drive file=/Volumes/nvme/qemu-vms/fed/edk2-arm-vars.fd,if=pflash,format=raw \
  -fw_cfg name=opt/com.coreos/config,file=/Volumes/nvme/qemu-vms/fed/config.ign \
  -drive file=/Volumes/nvme/qemu-vms/fed/fed.qcow2,id=disk,if=virtio,cache=writethrough \
  -drive file=/Volumes/nvme/plex.qcow2,id=plex,if=virtio,cache=writethrough \
  -drive file=/Volumes/nvme/docker.qcow2,id=docker,if=virtio,cache=writethrough \
  -device qemu-xhci \
  -netdev vmnet-bridged,id=n1,ifname=en0 \
  -device virtio-net,netdev=n1,mac=44:4e:b0:fb:6b:f2 \
  -device usb-host,vendorid=0x0451,productid=0x16a8 \
  -name fed \
  -nographic
```

