package com.doctine.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Doctine · keeps the Supabase sign-in session encrypted on the device.
 * Values are encrypted with AES-256-GCM using a key that lives in the Android Keystore (it never leaves the secure
 * hardware/OS store and is not included in backups). Only Supabase's own session keys are accepted. Nothing is logged.
 * If a value can't be decrypted (for example after the key was reset), it is deleted and the person signs in again.
 */
@CapacitorPlugin(name = "DoctineSecure")
public class DoctineSecurePlugin extends Plugin {
    private static final String ALIAS = "doctine.session.v1";
    private static final String PREFS = "doctine_secure";
    private static final Pattern KEY = Pattern.compile("^sb-[a-z0-9]{6,40}-auth-token(-code-verifier)?$");

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(ALIAS)) {
            KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            return g.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static boolean valid(String k) {
        return k != null && KEY.matcher(k).matches();
    }

    @PluginMethod
    public void get(PluginCall call) {
        String k = call.getString("key");
        if (!valid(k)) { call.reject("invalid key"); return; }
        JSObject r = new JSObject();
        String stored = prefs().getString(k, null);
        if (stored == null) { r.put("value", JSONObject.NULL); call.resolve(r); return; }
        try {
            byte[] all = Base64.decode(stored, Base64.NO_WRAP);
            byte[] iv = Arrays.copyOfRange(all, 0, 12);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            r.put("value", new String(c.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8));
        } catch (Exception e) {
            prefs().edit().remove(k).apply();
            r.put("value", JSONObject.NULL);
        }
        call.resolve(r);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String k = call.getString("key"), v = call.getString("value");
        if (!valid(k) || v == null) { call.reject("invalid key or value"); return; }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = c.getIV(), ct = c.doFinal(v.getBytes(StandardCharsets.UTF_8));
            byte[] all = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, all, 0, iv.length);
            System.arraycopy(ct, 0, all, iv.length, ct.length);
            prefs().edit().putString(k, Base64.encodeToString(all, Base64.NO_WRAP)).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("could not store the session");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String k = call.getString("key");
        if (!valid(k)) { call.reject("invalid key"); return; }
        prefs().edit().remove(k).apply();
        call.resolve();
    }
}
