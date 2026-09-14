// js/app.js (agora na raiz)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // ✅ Como estão na mesma pasta, ./sw.js funciona perfeitamente
    navigator.serviceWorker.register('../sw.js')
      .then((registration) => {
        console.log('Service Worker registrado com sucesso:', registration.scope);
      })
      .catch((error) => {
        console.error('Falha ao registrar o Service Worker:', error);
      });
  });
}
// ... (o resto do código do botão de instalar continua igual)
/* =============================================
   BOTÃO "INSTALAR weneed" (PWA)
============================================= */
let deferredPrompt;
const btnInstalar = document.getElementById('btn-instalar');

window.addEventListener('beforeinstallprompt', (e) => {
  // Previne o comportamento padrão do navegador
  e.preventDefault();
  // Salva o evento para usar depois
  deferredPrompt = e;
  // Mostra o botão de instalação
  if (btnInstalar) btnInstalar.style.display = 'block';
});

if (btnInstalar) {
  btnInstalar.addEventListener('click', async () => {
    if (deferredPrompt) {
      // Mostra o prompt de instalação
      deferredPrompt.prompt();
      // Aguarda a escolha do usuário
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        console.log('Usuário aceitou a instalação do weneed');
      }
      // Limpa a variável
      deferredPrompt = null;
      btnInstalar.style.display = 'none';
    }
  });

  // Esconde o botão se o app já estiver instalado
  window.addEventListener('appinstalled', () => {
    if (btnInstalar) btnInstalar.style.display = 'none';
    console.log('weneed instalado com sucesso!');
  });
}