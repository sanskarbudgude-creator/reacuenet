package com.rescuenet.app;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.Inet4Address;

@CapacitorPlugin(name = "NetInfo")
public class NetInfoPlugin extends Plugin {

    @PluginMethod
    public void getAddresses(PluginCall call) {
        JSArray list = new JSArray();
        try {
            ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            Network[] networks = cm.getAllNetworks();
            for (Network n : networks) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(n);
                if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    continue;
                }
                LinkProperties lp = cm.getLinkProperties(n);
                if (lp == null) {
                    continue;
                }
                for (LinkAddress la : lp.getLinkAddresses()) {
                    if (la.getAddress() instanceof Inet4Address) {
                        list.put(la.getAddress().getHostAddress() + "/" + la.getPrefixLength());
                    }
                }
            }
        } catch (Exception e) {
            // return whatever was found
        }
        JSObject ret = new JSObject();
        ret.put("addresses", list);
        call.resolve(ret);
    }
}
