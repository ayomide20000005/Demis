AI-powered VS Code extension that suggests and sets up your entire development environment based on your role  and saves it as a shareable package so your whole team can replicate it instantly.

Setting up a development environment from scratch is slow, inconsistent and frustrating. Every developer on a team ends up with slightly different tools, extensions and configurations. Demis solves this by using AI to understand your role — frontend developer, backend developer, data scientist, DevOps engineer and more — and automatically recommending the exact tools, VS Code extensions and packages you need.
The key idea is that your entire environment gets saved into a structured file. Anyone on your team can take that file, run Demis, and get the exact same setup on their machine in minutes. No more "works on my machine" problems.

![number 1](https://github.com/user-attachments/assets/57a76fe3-b7ce-41d8-8f60-306e5170191e)

How It Works
When you open Demis inside VS Code, a chat interface appears. You describe your role or what you are working on. Demis uses AI to analyse your input and generate a recommended dev environment — a curated list of VS Code extensions, npm packages, tools and configurations that fit your workflow. Once you confirm, Demis installs everything automatically. The final environment is serialised into a shareable package.json-style file that anyone can import.
System Design
Demis is built as a VS Code extension using the VS Code Extension API. The chat interface is rendered inside a VS Code Webview Panel, which allows a full HTML and JavaScript UI to run inside the editor. User input from the chat is passed to an AI layer that interprets the role description and maps it to a set of recommended tools and packages. The recommendation engine uses a combination of AI reasoning and predefined role-based profiles to generate environment suggestions. The output is structured as a JSON config file that captures every extension ID, package name and configuration setting. This file can be committed to a repository and shared across a team. When a new developer opens the project, Demis reads the config file and bootstraps their environment automatically

Tech Stack
TypeScript is the primary language used throughout the extension. The VS Code Extension API handles all editor integration including commands, webview panels, file system access and extension installation. Node.js powers the backend logic including file reading, writing and package management operations. The Webview Panel uses standard HTML, CSS and JavaScript for the chat interface rendered inside VS Code. The AI layer handles natural language understanding of role descriptions and maps them to environment recommendations.

donwload here......... https://github.com/ayomide20000005/Demis/releases

Why It Matters
Most onboarding processes involve a long document of manual steps. Demis replaces that with a conversation. You tell it what you do, it sets everything up and saves the result so the next person never has to go through the same process again. It is open source and built for developers who value consistency and speed.

![imported file](https://github.com/user-attachments/assets/996b393e-ea4c-4cc7-873c-c0ba65d70078)

