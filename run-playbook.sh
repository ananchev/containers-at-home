#!/bin/bash

# Ensure we are running from the script's root directory
cd "$(dirname "$0")"

if [ "$#" -lt 3 ]; then
  echo "Error: Missing arguments."
  echo "Usage: $0 <inventory_name> <app_name> <private_key_file> [extra_options...]"
  echo "Example: $0 unas rustdesk /path/to/private_key.pem"
  exit 1
fi

INV_NAME=$1
APP_NAME=$2
PRIVATE_KEY_FILE=$3
INV_PATH="ansible/inventories/${INV_NAME}/hosts"
PLAYBOOK_FILE="ansible/applications/${APP_NAME}.yml"

# Automatic Symlink Maintenance
# This ensures that any inventory folder has access to the global group_vars
if [ -d "ansible/inventories/${INV_NAME}" ] && [ ! -L "ansible/inventories/${INV_NAME}/group_vars" ]; then
    echo "Setting up variable links for ${INV_NAME}..."
    ln -s ../group_vars "ansible/inventories/${INV_NAME}/group_vars"
fi

# Validation of inventory and playbook files
if [ ! -f "$INV_PATH" ]; then
  echo "Error: Inventory '${INV_NAME}' not found at ${INV_PATH}"
  exit 1
fi

if [ ! -f "$PLAYBOOK_FILE" ]; then
  echo "Error: App playbook '${APP_NAME}' not found at ${PLAYBOOK_FILE}"
  exit 1
fi

if [ ! -f "$PRIVATE_KEY_FILE" ]; then
  echo "Error: Private key file not found at ${PRIVATE_KEY_FILE}"
  exit 1
fi

shift 3

echo "Executing: $APP_NAME on $INV_NAME"
echo "---------------------------------------------------"

ansible-playbook \
    -i "$INV_PATH" \
    --ask-vault-pass \
    --private-key "$PRIVATE_KEY_FILE" \
    "$PLAYBOOK_FILE" \
    "$@"