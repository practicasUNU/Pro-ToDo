<script setup lang="ts">
import { computed, reactive, watch } from 'vue';
import { useQuasar } from 'quasar';

import { useUsersStore } from '@stores/users.store';

import { corporateEmailErrorMessage, isCorporateEmail } from '@/utils/corporate-email';

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

// Filtro de dominios corporativos (Poka-Yoke): compartido con LoginPage.vue,
// vive en @/utils/corporate-email desde que lo necesitan dos vistas.

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

<template>
  <q-dialog :model-value="modelValue" persistent @update:model-value="onDialogToggle">
    <q-card class="pd-dialog-card">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <span class="pd-icon-circle">
          <q-icon name="person_add" size="20px" class="pd-dialog-icon" />
        </span>
        <div class="pd-h2">{{ isEditMode ? 'Editar usuario' : 'Nuevo usuario' }}</div>
      </q-card-section>

      <q-form @submit.prevent="onSubmit">
        <q-card-section class="q-gutter-md q-pt-none">
          <div>
            <label class="pd-label" for="user-email">
              Correo corporativo<span class="pd-required">*</span>
            </label>
            <q-input
              id="user-email"
              v-model="form.email"
              type="email"
              outlined
              dense
              class="q-mt-xs"
              placeholder="usuario@unuware.com"
              :rules="[
                (val: string) => !!val || 'El correo es obligatorio',
                (val: string) => isCorporateEmail(val) || corporateEmailErrorMessage,
              ]"
            />
          </div>

          <!-- Selector determinista: evita errores de tipeo en el rol (Poka-Yoke) -->
          <div>
            <label class="pd-label" for="user-role">Rol<span class="pd-required">*</span></label>
            <q-select
              id="user-role"
              v-model="form.role"
              :options="roleOptions"
              outlined
              dense
              class="q-mt-xs"
              emit-value
              map-options
              :rules="[(val: UserRole | null) => !!val || 'El rol es obligatorio']"
            />
          </div>
        </q-card-section>

        <q-card-actions align="right" class="q-px-md q-pb-md">
          <q-btn flat no-caps label="Cancelar" class="pd-btn-cancel" @click="closeDialog" />
          <q-btn
            class="pd-btn-primary"
            unelevated
            no-caps
            label="Guardar"
            icon-right="north_east"
            type="submit"
            :loading="usersStore.isLoading"
          />
        </q-card-actions>
      </q-form>
    </q-card>
  </q-dialog>
</template>

<style scoped lang="scss">
.pd-dialog-icon {
  color: var(--pd-primary);
}

.pd-btn-cancel {
  color: var(--pd-text-secondary);
}

// Campos e inputs sobre los tokens del sistema (regla §2, Formularios).
:deep(.q-field--outlined .q-field__control) {
  background: var(--pd-card-bg);
}

:deep(.q-field--outlined .q-field__control::before) {
  border-color: var(--pd-border);
}

:deep(.q-field__native::placeholder) {
  color: var(--pd-text-secondary);
}
</style>
