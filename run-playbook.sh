#!/bin/bash

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Error: Missing arguments."
  echo "Usage: $0 inventory_file playbook.yml"
  exit 1
fi

INVENTORY_FILE=$1
PLAYBOOK_FILE=$2

ansible-playbook \
    -i "$INVENTORY_FILE" \
    --private-key /Users/ananchev/.ssh/id_rsa_fed \
    --ask-vault-pass \
    "$PLAYBOOK_FILE"
