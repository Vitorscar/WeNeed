// ============================================================
// guard.js — protege páginas por sessão e por tipo de conta.
// ============================================================

const Guard = {

  async require(tipoEsperado = null) {
    const { data: { session } } = await supabase.auth.getSession();

    if (!session) {
      window.location.href = this._loginPathFromHere();
      return null;
    }

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .single();

    if (error || !profile) {
      await supabase.auth.signOut();
      window.location.href = this._loginPathFromHere();
      return null;
    }

    if (profile.status === 'bloqueado') {
      Utils.toast('Sua conta está bloqueada. Fale com o suporte.', 'error');
      await supabase.auth.signOut();
      window.location.href = this._loginPathFromHere();
      return null;
    }

    if (tipoEsperado && profile.tipo !== tipoEsperado) {
      window.location.href = this._dashboardPathFromHere(profile.tipo);
      return null;
    }

    return profile;
  },

  // ✅ MUDOU: agora aponta para entrar.html, não index.html
  _loginPathFromHere() {
    const inSubfolder = /\/(cliente|prestador|admin|publico)\//.test(window.location.pathname);
    return inSubfolder ? '../entrar.html' : 'entrar.html';
  },

  _dashboardPathFromHere(tipo) {
    const inSubfolder = /\/(cliente|prestador|admin|publico)\//.test(window.location.pathname);
    const prefix = inSubfolder ? '../' : '';
    if (tipo === 'admin') return prefix + 'admin/dashboard.html';
    if (tipo === 'prestador') return prefix + 'prestador/dashboard-prestador.html';
    return prefix + 'cliente/dashboard-cliente.html';
  }

};