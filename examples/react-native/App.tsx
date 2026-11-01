import { BunvexProvider, BunvexReactClient, useMutation, useQuery } from "@bunvex/react";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { api } from "./bunvex/_generated/api";

// `bunvex dev` writes the local deployment's URL to .env.local as EXPO_PUBLIC_BUNVEX_URL; Expo inlines it.
const url = process.env.EXPO_PUBLIC_BUNVEX_URL;
if (!url) throw new Error("EXPO_PUBLIC_BUNVEX_URL is not set: start the app with `bun run dev`");
const client = new BunvexReactClient(url);

function Chat() {
  const messages = useQuery(api.messages.list) ?? [];
  const send = useMutation(api.messages.send);
  const [author] = useState(() => `User ${Math.floor(Math.random() * 10000)}`);
  const [body, setBody] = useState("");

  const submit = () => {
    const text = body.trim();
    if (!text) return;
    setBody("");
    void send({ body: text, author });
  };

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>bunvex chat</Text>
      <Text style={styles.subtitle}>
        You are <Text style={styles.bold}>{author}</Text>
      </Text>
      <FlatList
        style={styles.list}
        data={messages}
        keyExtractor={(m) => m._id}
        renderItem={({ item }) => (
          <View style={[styles.message, item.author === author && styles.mine]}>
            <Text style={styles.author}>{item.author}</Text>
            <Text>{item.body}</Text>
          </View>
        )}
      />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.composer}>
        <TextInput
          style={styles.input}
          value={body}
          onChangeText={setBody}
          onSubmitEditing={submit}
          placeholder="Write a message…"
          returnKeyType="send"
        />
        <Pressable style={styles.button} onPress={submit} disabled={!body.trim()}>
          <Text style={styles.buttonText}>Send</Text>
        </Pressable>
      </KeyboardAvoidingView>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <BunvexProvider client={client}>
        <Chat />
      </BunvexProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#fff", paddingHorizontal: 16 },
  title: { fontSize: 24, fontWeight: "700", marginTop: 8 },
  subtitle: { color: "#555", marginBottom: 12 },
  bold: { fontWeight: "700" },
  list: { flex: 1 },
  message: { backgroundColor: "#f1f1f4", borderRadius: 12, padding: 10, marginVertical: 4, alignSelf: "flex-start" },
  mine: { backgroundColor: "#dbeafe", alignSelf: "flex-end" },
  author: { fontSize: 12, color: "#666", marginBottom: 2 },
  composer: { flexDirection: "row", gap: 8, paddingVertical: 12 },
  input: { flex: 1, borderWidth: 1, borderColor: "#ccc", borderRadius: 8, paddingHorizontal: 12, height: 44 },
  button: { backgroundColor: "#2563eb", borderRadius: 8, paddingHorizontal: 16, justifyContent: "center" },
  buttonText: { color: "#fff", fontWeight: "600" },
});
