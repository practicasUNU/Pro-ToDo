<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="onDialogToggle">
    <q-card style="min-width: 380px">
      <q-card-section>
        <div class="text-h6">{{ isEditMode ? 'Editar usuario' : 'Nuevo usuario' }}</div>
      </q-card-section>

      <q-form @submit.prevent="onSubmit">
        <q-card-section class="q-gutter-md">
          <q-input
            v-model="form.email"
            label="Correo"
            type="email"
            outlined
            :rules="[
              (val: string) => !!val || 'El correo es obligatorio',
              (val: string) => isCorporateEmail(val) || corporateEmailErrorMessage,
            ]"
          />

          <!-- Selector determinista: evita errores de tipeo en el rol (Poka-Yoke) -->
          <q-select
            v-model="form.role"
            :options="roleOptions"
            label="Rol"
            outlined
            emit-value
            map-options
            :rules="[(val: UserRole | null) => !!val || 'El rol es obligatorio']"
          />
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat label="Cancelar" color="primary" @click="closeDialog" />
          <q-btn
            flat
            label="Guardar"
            color="primary"
            type="submit"
            :loading="usersStore.isLoading"
          />
        </q-card-actions>
      </q-form>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { useQuasar } from 'quasar';

import { useUsersStore } from '@stores/users.store';

import { UserRole, type User } from '@/types/user';

interface Props {
  modelValue: boolean;
  user: User | null;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  saved: [];
}>();

const $q = useQuasar();
const usersStore = useUsersStore();

const roleOptions = [
  { label: 'Administrador', value: UserRole.ADMIN },
  { label: 'Editor', value: UserRole.EDITOR },
];

// Filtro de dominios corporativos (Poka-Yoke): bloquea el envio si el correo no pertenece a un dominio autorizado
const acceptedEmailDomains = (import.meta.env.VITE_ACCEPTED_EMAIL_DOMAINS ?? '')
  .split(',')
  .map((domain) => domain.trim())
  .filter(Boolean);

const corporateEmailErrorMessage = `El correo debe pertenecer a un dominio corporativo autorizado (${acceptedEmailDomains.join(', ')})`;

const isCorporateEmail = (value: string): boolean => {
  if (acceptedEmailDomains.length === 0) return true;
  return acceptedEmailDomains.some((domain) => value.toLowerCase().endsWith(domain.toLowerCase()));
};

const form = reactive<{ email: string; role: UserRole | null }>({
  email: '',
  role: null,
});

const isEditMode = computed(() => !!props.user);

const resetForm = (): void => {
  form.email = props.user?.email ?? '';
  form.role = props.user?.role ?? null;
};

watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) resetForm();
  },
);

const onDialogToggle = (value: boolean): void => emit('update:modelValue', value);

const closeDialog = (): void => emit('update:modelValue', false);

const onSubmit = async (): Promise<void> => {
  if (!form.role) return;

  try {
    if (isEditMode.value && props.user) {
      await usersStore.updateUser(props.user.id, { email: form.email, role: form.role });
    } else {
      await usersStore.createUser({ email: form.email, role: form.role });
    }

    emit('saved');
    closeDialog();
  } catch {
    $q.notify({ type: 'negative', message: 'No se pudo guardar el usuario' });
  }
};
</script>
