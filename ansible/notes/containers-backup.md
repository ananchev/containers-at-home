### Conditional Backup Execution

The backup system is designed to run from a single playbook (`take_backups.yml`) across multiple hosts. It selectively performs backups by dynamically checking if an application belongs to the host the playbook is currently running on.

This is achieved by:

1.  **Centralized Host Mapping**: A central variable file (`vars/application_hosts.yml`) defines which host each application is assigned to. This provides a single source of truth for application placement.

    ```yaml
    # app_hosts.yml
    application_hosts:
      zigbee2mqtt: fed
      rustdesk: unraid
      # ...
    ```

2.  **Decoupled Backup Definitions**: The `backup_definitions.yml` file only contains the technical steps for backing up an application, without any host information.

    ```yaml
    # backup_definitions.yml
    backup_definitions:
      - application: zigbee2mqtt
        container: zigbee2mqtt
        # ...
    ```

3.  **Dynamic `when` condition**: The main backup task in `take_backups.yml` loops through all backup definitions. It uses a `when` condition to look up the application's assigned host from the central mapping and compares it to the `inventory_hostname` of the machine it's currently running on.

    ```yaml
    # take_backups.yml
    - name: Backup containers
      include_tasks: backup_tasks.yml
      loop: "{{ backup_definitions }}"
      # This condition looks up the host and compares it to the current host
      when: application_hosts[item.application] == inventory_hostname
      # ...
    ```

4.  **Leveraging `inventory_hostname`**: Ansible's `inventory_hostname` magic variable provides the name of the current host as defined in the inventory file (e.g., `fed`, `unraid`). This allows the `when` condition to dynamically filter and execute only the relevant backups for each host.