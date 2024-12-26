## Execute with sudo
1. Create a vault file
```bash
ansible-vault create vault.yml
```
Make sure to remember well the vault master password supplied upon creating the vault.

2. Store the sudo password
```yml
ansible_become_pass: YourSudoPassword
```
3. Modify the playbook to include the vault file
```yml
- hosts: coreos
  gather_facts: False
  vars_files:
    - vault.yml
  tasks:
```
4. Add a variable to the vault
```bash
ansible-vault edit my_vault.yml
```
Add the new variable and save.
5. Use variable in the playbook
Sample content of the vault
```yml
vault_db_password: "s3cr3t_p@ssw0rd"
vault_api_key: "1234567890abcdef"
```
Code snippet how to retrieve a value from the vault into the playbook:
```yml
    - name: Display the API key
      debug:
        msg: "The API key is {{ vault_api_key }}"
```
6. Run the playbook with ... and supply the vault master password.
```bash
ansible-playbook -i inventory playbook.yml --ask-vault-pass
```
7. You can use rekey keyword in your ansible-vault command to reset the password of a vault.
```bash
ansible-vault rekey vault.yml
```