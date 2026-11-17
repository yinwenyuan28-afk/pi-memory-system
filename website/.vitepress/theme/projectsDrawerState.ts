import { ref } from 'vue';

export const projectsDrawerOpen = ref(false);

export function openProjectsDrawer() {
  projectsDrawerOpen.value = true;
}

export function closeProjectsDrawer() {
  projectsDrawerOpen.value = false;
}
