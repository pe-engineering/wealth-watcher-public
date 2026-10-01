FROM mcr.microsoft.com/dotnet/sdk:10.0@sha256:35d40304542c8689331f8cab17c65926cdf48fe711e289321d71924b230a7d29 AS build
WORKDIR /src
COPY ["WealthWatcher.Api.csproj", "./"]
RUN dotnet restore "./WealthWatcher.Api.csproj"
COPY . .
RUN dotnet publish "WealthWatcher.Api.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0@sha256:2d584d8147faddb0d678c5748d47953e5b8e18621ed4fb7049a91381d9d7746f AS final
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgssapi-krb5-2=1.20.1-6ubuntu2.8 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
EXPOSE 8080
COPY --from=build /app/publish .
USER $APP_UID
ENTRYPOINT ["dotnet", "WealthWatcher.Api.dll"]
