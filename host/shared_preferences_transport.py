"""Shared preference selector over the existing bounded wired command transport."""
import base64
from ordinary_export_transport import parse, exact, digest, uuid
from portable_configuration_transport import CONFIG, MAX_REQUEST, artifact, execute, main

SELECTORS = {'inspect', 'edit', 'status'}
PREFIX = ('/usr/bin/env -i HOME=/home/root PATH=/opt/bin:/usr/bin:/bin '
          'REMARKABLE_BUDDIES_CONFIG=' + CONFIG +
          ' /opt/bin/reader-buddy --shared-preferences-operation ')


def command(selector):
    if selector not in SELECTORS:
        raise ValueError('input refused')
    return PREFIX + selector + ' --shared-preferences-input -'


def request(raw):
    v = parse(raw, MAX_REQUEST)
    exact(v, 'connection_id boot_id selector input_base64 budget_ms')
    selector = v['selector']
    if (not digest(v['connection_id']) or not uuid(v['boot_id']) or
            type(v['budget_ms']) is not int or not 1 <= v['budget_ms'] <= 12000 or
            selector not in SELECTORS or not isinstance(v['input_base64'], str)):
        raise ValueError('input refused')
    body = base64.b64decode(v['input_base64'], validate=True)
    if base64.b64encode(body).decode('ascii') != v['input_base64']:
        raise ValueError('input refused')
    value = parse(body, 262144)
    if selector == 'inspect':
        exact(value, 'shared_preferences_version reveal_text')
        if type(value['reveal_text']) is not bool:
            raise ValueError('input refused')
    else:
        exact(value, 'shared_preferences_version operation guard ' +
              ('patch' if selector == 'edit' else 'patch_sha256'))
        if not uuid(value['operation']):
            raise ValueError('input refused')
        guard = value['guard']
        exact(guard, 'group mode_epoch binding_sha256 store_generation local_config_sha256 selection')
        if (not all(uuid(guard[key]) for key in ('group', 'mode_epoch', 'store_generation')) or
                not all(digest(guard[key]) for key in ('binding_sha256', 'local_config_sha256'))):
            raise ValueError('input refused')
        selection = guard['selection']
        if isinstance(selection, dict) and selection.get('kind') == 'absent':
            exact(selection, 'kind')
        else:
            exact(selection, 'kind aggregate_generation accepted_base_sha256 selection_sha256 revision')
            if (selection['kind'] != 'selected' or not uuid(selection['aggregate_generation']) or
                    not uuid(selection['revision']) or not digest(selection['accepted_base_sha256']) or
                    not digest(selection['selection_sha256'])):
                raise ValueError('input refused')
        if selector == 'edit':
            artifact(value['patch'])
        elif not digest(value['patch_sha256']):
            raise ValueError('input refused')
    if type(value['shared_preferences_version']) is not int or value['shared_preferences_version'] != 1:
        raise ValueError('input refused')
    return v


def report_shape(value, selector):
    exact(value, 'report_version operation status runtime_activation data')
    if (type(value['report_version']) is not int or value['report_version'] != 1 or
            value['operation'] != selector or value['runtime_activation'] != 'unverified'):
        raise ValueError('report refused')


def invoke(transport, v, deadline):
    return execute(transport, v, deadline, command_for=command, report_limit=131072,
                   validate_report=report_shape)


if __name__ == '__main__':
    main(request, invoke)
